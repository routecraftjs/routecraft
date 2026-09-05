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
 * through `sessions: { store }`: one slot per `(agent, session)`, written
 * under a compare-and-swap and validated on every read, since the value
 * crossed a process boundary. The continuation a turn stores between turns
 * is a parked exchange, so it lives in the suspension store beside every
 * other one, and releasing it goes through that store's own transitions.
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
   * Load the session, creating an empty one on first use, then apply
   * `mutate` and write the result back. Retried on a lost compare-and-swap
   * with the state that landed, so two writers never overwrite each other:
   * an inbox append and a transcript write race to the same record from
   * different exchanges. A mutation that returns its input unchanged is
   * not written, so a no-op costs one read.
   */
  async update(
    key: AgentSessionKey,
    mutate: (record: AgentSessionRecord) => AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await this.records.get(key);
      if (!stored) {
        const empty = emptyRecord(key);
        const first = mutate(empty);
        const value = first === empty ? empty : stamped(first);
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
      message: `Agent session "${key.session}" of "${key.agent}" could not be written after ${CAS_ATTEMPTS} attempts: another writer kept winning the compare-and-swap.`,
    });
  }
}

function emptyRecord(key: AgentSessionKey): AgentSessionRecord {
  const now = new Date().toISOString();
  return {
    kind: "agent-session",
    version: SESSION_RECORD_VERSION,
    agent: key.agent,
    session: key.session,
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
    record.agent !== key.agent ||
    record.session !== key.session ||
    !Array.isArray(record.messages) ||
    !Array.isArray(record.inbox) ||
    !Array.isArray(record.background) ||
    typeof record.turns !== "number"
  ) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key.session}" of "${key.agent}" is not the { kind: "agent-session", messages, inbox, background, turns } shape the runtime writes.`,
    });
  }
  if (!isParkOrAbsent(record.park) || !isParkOrAbsent(record.parking)) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key.session}" of "${key.agent}" names a continuation that is not a { suspensionId, routeId } pair, so the boot that would release it cannot read it.`,
    });
  }
  if (record.version !== SESSION_RECORD_VERSION) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key.session}" of "${key.agent}" was written at version ${String(record.version)} and this build reads version ${String(SESSION_RECORD_VERSION)}: two releases of @routecraft/ai share one store, or the record predates this one.`,
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
