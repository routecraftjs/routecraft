import { rcError, type DeferralStore } from "@routecraft/routecraft";
import type { SessionStore } from "./port.ts";
import {
  SESSION_RECORD_VERSION,
  type AgentSessionKey,
  type AgentSessionDeferral,
  type AgentSessionRecord,
} from "./types.ts";
// Registers AI1010, thrown from the record checks below.
import "../../errors.ts";

const CAS_ATTEMPTS = 20;

/**
 * The typed layer over the two stores a session touches.
 *
 * Session records live in the {@link SessionStore} the context resolved
 * through `sessions: { store }`: one slot per session id, written under a
 * compare-and-swap and validated on every read, since the value crossed a
 * process boundary. The continuation a turn stores between turns is a
 * deferred exchange, so it lives in the deferral store beside every other
 * one, and releasing it goes through that store's own transitions.
 */
export class AgentSessionStore {
  constructor(
    private readonly records: SessionStore,
    private readonly defers: DeferralStore,
  ) {}

  /** The stored record, or `undefined` for a session the store has never seen. */
  async load(key: AgentSessionKey): Promise<AgentSessionRecord | undefined> {
    const stored = await this.records.get(key);
    if (!stored) return undefined;
    return parseSessionRecord(stored.value, key);
  }

  /**
   * Settle a stored continuation nothing will revive: a deferral whose work
   * another turn consumed. Denied rather than left, so the store does not
   * hold a live continuation for a turn that already happened.
   */
  async releaseDeferral(deferralId: string, reason: string): Promise<void> {
    // Claim first: `markDenied` only settles a claimed record, and a record
    // nothing revives is still waiting and unclaimed. Losing the claim means
    // another party settled it already, and that outcome stands.
    const claim = await this.defers.claimExpiry(deferralId, new Date());
    if (!claim.won) return;
    await this.defers.markDenied(deferralId, reason);
  }

  /** Every session the store holds. */
  async list(): Promise<AgentSessionKey[]> {
    return this.records.keys();
  }

  /**
   * Forget a conversation: its transcript, its inbox and everything else
   * the record holds. What a person archives or deletes from a client
   * ends here.
   *
   * A stored continuation is settled before the record goes. An aside deferral
   * carries no expiry, and the only thing naming it is the record being
   * deleted, so leaving it would leave a deferral nothing can ever
   * revive or retire. Both fields are released: the one the record named,
   * and the one a deferral announced but had not yet named, which is the same
   * pair the boot walk settles.
   *
   * The ids are read out of the raw stored value rather than through
   * {@link load}, and that is the point of the method rather than a
   * shortcut. A record that fails validation is exactly the one an
   * operator has been told to remove (`AI1010` says so), so a delete that
   * parsed first would refuse the one case it exists to answer. Whatever
   * can be read is released, and the record goes either way.
   *
   * A turn writing while this runs can still store a continuation the
   * delete then removes without settling. That race is real and is not
   * closed here: nothing in the framework calls this method, so it needs a
   * caller before it needs a protocol, and the shape that closes it
   * safely (a fenced delete, and a crash between the two halves that
   * cannot poison a later boot) is tracked in #745. Delete a
   * conversation you have decided is finished, which is what the port's
   * own contract asks for.
   */
  async remove(key: AgentSessionKey): Promise<void> {
    const stored = await this.records.get(key);
    for (const deferralId of deferralIdsIn(stored?.value)) {
      await this.releaseDeferral(deferralId, "agent session removed");
    }
    await this.records.remove(key);
  }

  /**
   * Read the session, apply `mutate` and write the result back. Retried on
   * a lost compare-and-swap with the state that landed, so two writers
   * never overwrite each other: an inbox append and a transcript write
   * race to the same record from different exchanges. A mutation that
   * returns its input unchanged is not written, so a no-op costs one read.
   *
   * `mutate` is handed `undefined` for a session the store has never seen
   * and answers with the record to create. Everything a record carries
   * therefore arrives one way, through the mutation, rather than through a
   * mutation for most fields and a parameter for one of them.
   */
  async update(
    key: AgentSessionKey,
    mutate: (record: AgentSessionRecord | undefined) => AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await this.records.get(key);
      if (!stored) {
        const value = stamped(mutate(undefined));
        // A create that loses to a concurrent first write reads that write
        // back on the next attempt.
        if ((await this.records.create(key, value)).won) return value;
        continue;
      }
      const current = parseSessionRecord(stored.value, key);
      const next = mutate(current);
      if (next === current) return current;
      const value = stamped(next);
      if ((await this.records.replace(key, stored.version, value)).won) {
        return value;
      }
    }
    throw rcError("AI1010", undefined, {
      message: `Agent session "${key}" could not be written after ${CAS_ATTEMPTS} attempts: another writer kept winning the compare-and-swap.`,
    });
  }
}

/**
 * The record a conversation starts life as, for a caller that has decided
 * to create one. The agent is supplied here because a record must name
 * one from the moment it exists, and only the caller knows which.
 */
export function emptyAgentSession(
  key: AgentSessionKey,
  agent: string,
): AgentSessionRecord {
  const now = new Date().toISOString();
  return {
    kind: "agent-session",
    version: SESSION_RECORD_VERSION,
    agent,
    session: key,
    messages: [],
    inbox: [],
    background: [],
    turns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function stamped(record: AgentSessionRecord): AgentSessionRecord {
  return { ...record, updatedAt: new Date().toISOString() };
}

/**
 * Validate a value read back off the store. It crossed a process boundary,
 * so nothing about its shape is assumed.
 *
 * @throws AI1010 when the value is not a session record for `key`
 */
export function parseSessionRecord(
  value: unknown,
  key: AgentSessionKey,
): AgentSessionRecord {
  const record = value as Partial<AgentSessionRecord> | null | undefined;
  if (
    record === null ||
    typeof record !== "object" ||
    record.kind !== "agent-session" ||
    record.session !== key ||
    // Checked on its own now that it is not compared against anything: a
    // record whose agent crossed the boundary as something other than a
    // name would reach the executor lookup as one.
    typeof record.agent !== "string" ||
    !Array.isArray(record.messages) ||
    !Array.isArray(record.inbox) ||
    !Array.isArray(record.background) ||
    typeof record.turns !== "number"
  ) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key}" is not the { kind: "agent-session", messages, inbox, background, turns } shape the runtime writes.`,
    });
  }
  if (
    !isDeferralOrAbsent(record.deferral) ||
    !isDeferralOrAbsent(record.deferring)
  ) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key}" names a continuation that is not a { deferralId, routeId } pair, so the boot that would release it cannot read it.`,
    });
  }
  if (record.version !== SESSION_RECORD_VERSION) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key}" was written at version ${String(record.version)} and this build reads version ${String(SESSION_RECORD_VERSION)}: two releases of @routecraft/ai share one store, or the record predates this one.`,
    });
  }
  return record as AgentSessionRecord;
}

/**
 * Both continuation fields are dereferenced by the boot walk, so a record
 * that crossed a process boundary carrying something else fails here, at
 * the documented boundary, rather than as a TypeError mid-walk.
 */
function isDeferralOrAbsent(
  value: unknown,
): value is AgentSessionDeferral | undefined {
  if (value === undefined) return true;
  const deferral = value as Partial<AgentSessionDeferral> | null;
  return (
    deferral !== null &&
    typeof deferral === "object" &&
    typeof deferral.deferralId === "string" &&
    typeof deferral.routeId === "string"
  );
}

/**
 * The deferral ids a stored value names, read without validating it.
 *
 * Structural, one field at a time, because the caller is deleting a record
 * whose shape may be exactly what is wrong with it. Anything unreadable
 * yields nothing rather than throwing: an unreleased deferral is a leak, and a
 * delete that cannot proceed is a conversation nobody can get rid of.
 */
function deferralIdsIn(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as { deferral?: unknown; deferring?: unknown };
  const ids = new Set<string>();
  for (const deferral of [record.deferral, record.deferring]) {
    if (deferral === null || typeof deferral !== "object") continue;
    const { deferralId } = deferral as { deferralId?: unknown };
    if (typeof deferralId === "string" && deferralId !== "") {
      ids.add(deferralId);
    }
  }
  return [...ids];
}
