import { rcError, type SuspensionStore } from "@routecraft/routecraft";
import type { SessionStore } from "./port.ts";
import {
  SESSION_RECORD_VERSION,
  type AgentSessionKey,
  type AgentSessionPark,
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
 * parked exchange, so it lives in the suspension store beside every other
 * one, and releasing it goes through that store's own transitions.
 */
export class AgentSessionStore {
  constructor(
    private readonly records: SessionStore,
    private readonly parks: SuspensionStore,
  ) {}

  /** The stored record, or `undefined` for a session the store has never seen. */
  async load(key: AgentSessionKey): Promise<AgentSessionRecord | undefined> {
    const stored = await this.records.get(key);
    if (!stored) return undefined;
    return parseSessionRecord(stored.value, key);
  }

  /**
   * Settle a stored continuation nothing will revive: a park whose work
   * another turn consumed. Denied rather than left, so the store does not
   * hold a live continuation for a turn that already happened.
   */
  async releasePark(suspensionId: string, reason: string): Promise<void> {
    // Claim first: `markDenied` only leaves `expiring`, and a record nothing
    // revives is still `suspended`. Losing the claim means another party
    // settled it already, and that outcome stands.
    const claim = await this.parks.claimExpiry(suspensionId, new Date());
    if (!claim.won) return;
    await this.parks.markDenied(suspensionId, reason);
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
   * Deletion claims the record before it releases anything. The claim is
   * an ordinary compare-and-swap against the version just read, so a turn
   * writing at the same moment either lands before the claim (and is then
   * part of what this delete accounts for) or loses its swap and reads the
   * claim back. What it must never do is land in the gap between the
   * release and the delete: it would write a fresh continuation onto a
   * record about to be removed, and nothing would ever settle that one.
   * {@link update} refuses a claimed record, which is what closes the gap.
   *
   * A stored continuation is settled before the record goes. An aside park
   * carries no expiry, and the only thing naming it is the record being
   * deleted, so leaving it would leave a suspension nothing can ever
   * revive or retire. Both fields are released: the one the record named,
   * and the one a park announced but had not yet named, which is the same
   * pair the boot walk settles. The claim carries those ids forward, so a
   * process that dies between claiming and deleting leaves a record whose
   * next delete still knows what to release.
   *
   * The ids are read out of the raw stored value rather than through
   * {@link load}, and that is the point of the method rather than a
   * shortcut. A record that fails validation is exactly the one an
   * operator has been told to remove (`AI1010` says so), so a delete that
   * parsed first would refuse the one case it exists to answer. Whatever
   * can be read is released, and the record goes either way.
   */
  async remove(key: AgentSessionKey): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await this.records.get(key);
      // Nothing to delete, and nothing to report: deleting twice and
      // deleting what never existed both succeed.
      if (!stored) return;
      const parks = parkIdsIn(stored.value);
      const claim = await this.records.replace(
        key,
        stored.version,
        removalClaim(key, parks),
      );
      // Somebody wrote between the read and the claim. Read again: their
      // write may have added a continuation this delete has to account
      // for.
      if (!claim.won) continue;
      for (const suspensionId of parks) {
        await this.releasePark(suspensionId, "agent session removed");
      }
      await this.records.remove(key);
      return;
    }
    throw rcError("AI1010", undefined, {
      message: `Agent session "${key}" could not be removed after ${CAS_ATTEMPTS} attempts: another writer kept winning the compare-and-swap.`,
    });
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
      if (isRemovalClaim(stored.value)) {
        throw rcError("AI1010", undefined, {
          message: `Agent session "${key}" is being removed, so it cannot be written to. A conversation being deleted does not accept a turn, an inbox post or a stored continuation; start a new session instead.`,
        });
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
  if (!isParkOrAbsent(record.park) || !isParkOrAbsent(record.parking)) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key}" names a continuation that is not a { suspensionId, routeId } pair, so the boot that would release it cannot read it.`,
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
function isParkOrAbsent(value: unknown): value is AgentSessionPark | undefined {
  if (value === undefined) return true;
  const park = value as Partial<AgentSessionPark> | null;
  return (
    park !== null &&
    typeof park === "object" &&
    typeof park.suspensionId === "string" &&
    typeof park.routeId === "string"
  );
}

/** The shape a record wears between being claimed for deletion and going. */
const REMOVAL_CLAIM = "agent-session-removing";

/**
 * The value written to claim a record for deletion.
 *
 * It carries the suspension ids the record named, so a delete interrupted
 * between the claim and the record going still knows what to release when
 * it runs again. Deliberately not an `AgentSessionRecord`: nothing should
 * be able to read this as a conversation.
 */
function removalClaim(key: AgentSessionKey, parks: readonly string[]): unknown {
  return { kind: REMOVAL_CLAIM, session: key, parks: [...parks] };
}

/** Whether a stored value is a record already claimed for deletion. */
function isRemovalClaim(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === REMOVAL_CLAIM
  );
}

/**
 * The suspension ids a stored value names, read without validating it.
 *
 * Structural, one field at a time, because the caller is deleting a record
 * whose shape may be exactly what is wrong with it. Anything unreadable
 * yields nothing rather than throwing: an unreleased park is a leak, and a
 * delete that cannot proceed is a conversation nobody can get rid of.
 */
function parkIdsIn(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as {
    park?: unknown;
    parking?: unknown;
    parks?: unknown;
  };
  const ids = new Set<string>();
  // A claim left behind by an interrupted delete carries what that delete
  // had not released yet.
  if (Array.isArray(record.parks)) {
    for (const id of record.parks) {
      if (typeof id === "string" && id !== "") ids.add(id);
    }
  }
  for (const park of [record.park, record.parking]) {
    if (park === null || typeof park !== "object") continue;
    const { suspensionId } = park as { suspensionId?: unknown };
    if (typeof suspensionId === "string" && suspensionId !== "") {
      ids.add(suspensionId);
    }
  }
  return [...ids];
}
