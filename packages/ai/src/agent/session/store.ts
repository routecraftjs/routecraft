import {
  rcCodeOf,
  rcError,
  stepStateFingerprint,
  type SuspensionStore,
} from "@routecraft/routecraft";
import {
  SESSION_RECORD_VERSION,
  type AgentSessionKey,
  type AgentSessionRecord,
} from "./types.ts";
// Registers AI1010, thrown from the record checks below.
import "../../errors.ts";

/**
 * Session persistence over the suspension store.
 *
 * A session is not a parked exchange, but it needs exactly what a park
 * needs from a store: a durable free-form slot with a compare-and-swap on
 * write, on whichever backend the deployment configured. So each session
 * is one suspension record that never expires and is never resumed, with
 * the transcript and inbox in its `stepState`. The record's other fields
 * are filled with placeholders and mean nothing.
 *
 * The one cost of borrowing the store: the boot summary's `pending` count
 * includes session records, since the store cannot tell them apart.
 *
 * The store contract has no enumeration, so an index record lists every
 * session key. It is written through the same compare-and-swap.
 */

const RECORD_PREFIX = "agent-session:";
const INDEX_ID = "agent-sessions:index";
const CAS_ATTEMPTS = 20;

/** What the index record's slot holds. */
interface SessionIndex {
  readonly kind: "agent-session-index";
  readonly keys: readonly AgentSessionKey[];
}

/** Id of the record holding one session. */
export function sessionRecordId(key: AgentSessionKey): string {
  return `${RECORD_PREFIX}${encodeURIComponent(key.agent)}:${encodeURIComponent(key.session)}`;
}

export class AgentSessionStore {
  /** Record ids this process has confirmed in the index. */
  private readonly indexed = new Set<string>();

  constructor(private readonly store: SuspensionStore) {}

  /** The stored record, or `undefined` for a session the store has never seen. */
  async load(key: AgentSessionKey): Promise<AgentSessionRecord | undefined> {
    const record = await this.store.get(sessionRecordId(key));
    if (!record) return undefined;
    return parseSessionRecord(record.stepState, key);
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
    const claim = await this.store.claimExpiry(suspensionId, new Date());
    if (!claim.won) return;
    await this.store.markDenied(suspensionId, reason);
  }

  /** Every session key the index knows. */
  async list(): Promise<AgentSessionKey[]> {
    const record = await this.store.get(INDEX_ID);
    if (!record) return [];
    return [...parseIndex(record.stepState).keys];
  }

  /**
   * Load the session, creating an empty one on first use, then apply
   * `mutate` and write the result back. Retried on a lost compare-and-swap
   * with the state that landed, so two writers never overwrite each other:
   * an inbox append and a transcript write race to the same record from
   * different exchanges.
   */
  async update(
    key: AgentSessionKey,
    mutate: (record: AgentSessionRecord) => AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    const { value, created } = await this.cas<AgentSessionRecord>({
      id: sessionRecordId(key),
      key,
      parse: (slot) => parseSessionRecord(slot, key),
      empty: () => emptyRecord(key),
      mutate: (current) => {
        const next = mutate(current);
        // Unchanged input passes through untouched, which is what lets the
        // compare-and-swap skip the write for a no-op.
        return next === current ? current : stamped(next);
      },
      exhausted: `Agent session "${key.session}" of "${key.agent}" could not be written after ${CAS_ATTEMPTS} attempts: another writer kept winning the compare-and-swap.`,
    });
    // Indexed on creation and once more per process on the first write to
    // a record this process has not indexed: a record whose index write
    // failed after its own succeeded is repaired by its next write rather
    // than hidden from the listing for good.
    const id = sessionRecordId(key);
    if (created || !this.indexed.has(id)) {
      await this.index(key);
      this.indexed.add(id);
    }
    return value;
  }

  /** Add the key to the index record, creating the index on first use. */
  private async index(key: AgentSessionKey): Promise<void> {
    await this.cas<SessionIndex>({
      id: INDEX_ID,
      key,
      parse: parseIndex,
      empty: () => ({ kind: "agent-session-index", keys: [] }),
      mutate: (current) =>
        current.keys.some(
          (k) => k.agent === key.agent && k.session === key.session,
        )
          ? current
          : { ...current, keys: [...current.keys, key] },
      exhausted: `The agent session index could not be written after ${CAS_ATTEMPTS} attempts.`,
    });
  }

  /**
   * The one write path: read the slot, mutate it, write it back under a
   * compare-and-swap, and retry on a lost race with the state that landed.
   * A slot that does not exist yet is created from `empty`, and a create
   * that loses to a concurrent first write reads that write back on the
   * next attempt. A mutation that returns its input unchanged is not
   * written, so a no-op costs one read.
   */
  private async cas<S>(op: {
    id: string;
    key: AgentSessionKey;
    parse: (slot: unknown) => S;
    empty: () => S;
    mutate: (current: S) => S;
    exhausted: string;
  }): Promise<{ value: S; created: boolean }> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = await this.store.get(op.id);
      if (!existing) {
        const value = op.mutate(op.empty());
        try {
          await this.store.create({
            ...placeholderFields(op.id, op.key),
            stepState: value,
          });
        } catch (err) {
          if (isAlreadyExists(err)) continue;
          throw err;
        }
        return { value, created: true };
      }
      const current = op.parse(existing.stepState);
      const next = op.mutate(current);
      if (next === current) return { value: current, created: false };
      const cas = await this.store.replaceStepState(
        op.id,
        stepStateFingerprint(existing.stepState),
        next,
      );
      if (cas.won) return { value: next, created: false };
    }
    throw rcError("AI1010", undefined, { message: op.exhausted });
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
 * The record fields a session does not use, filled so the store accepts
 * the row. `expiresAt` is deliberately absent: the sweeper visits only
 * records with a deadline, so a session is never expired or retired by it.
 */
function placeholderFields(id: string, key: AgentSessionKey) {
  return {
    id,
    routeId: `agent:${key.agent}`,
    position: 0,
    continuationHash: "agent-session",
    actionFingerprint: id,
    exchange: { body: null, headers: {} },
    schema: { hash: "agent-session", absent: true },
    suspendedAt: new Date(),
  };
}

function isAlreadyExists(err: unknown): boolean {
  return rcCodeOf(err) === "RC5044";
}

/**
 * Validate a slot read back off a session record. The value crossed a
 * process boundary, so nothing about its shape is assumed.
 *
 * @throws AI1010 when the slot is not a session record for `key`
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
  if (record.version !== SESSION_RECORD_VERSION) {
    throw rcError("AI1010", undefined, {
      message: `The stored record for agent session "${key.session}" of "${key.agent}" was written at version ${String(record.version)} and this build reads version ${String(SESSION_RECORD_VERSION)}: two releases of @routecraft/ai share one store, or the record predates this one.`,
    });
  }
  return record as AgentSessionRecord;
}

function parseIndex(value: unknown): SessionIndex {
  const index = value as Partial<SessionIndex> | null | undefined;
  if (
    index === null ||
    typeof index !== "object" ||
    index.kind !== "agent-session-index" ||
    !Array.isArray(index.keys)
  ) {
    throw rcError("AI1010", undefined, {
      message:
        'The agent session index record is not the { kind: "agent-session-index", keys } shape the runtime writes.',
    });
  }
  return index as SessionIndex;
}
