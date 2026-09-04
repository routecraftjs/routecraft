import {
  rcError,
  stepStateFingerprint,
  type SuspensionStore,
} from "@routecraft/routecraft";
import type { AgentSessionKey, AgentSessionRecord } from "./types.ts";
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
  constructor(private readonly store: SuspensionStore) {}

  /** The stored record, or `undefined` for a session the store has never seen. */
  async load(key: AgentSessionKey): Promise<AgentSessionRecord | undefined> {
    const record = await this.store.get(sessionRecordId(key));
    if (!record) return undefined;
    return parseSessionRecord(record.stepState, key);
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
    const id = sessionRecordId(key);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = await this.store.get(id);
      if (!existing) {
        const created = mutate(emptyRecord(key));
        try {
          await this.store.create({
            ...placeholderFields(id, key),
            stepState: stamped(created),
          });
        } catch (err) {
          // A concurrent first write for the same session: the next
          // attempt reads it back and updates instead.
          if (isAlreadyExists(err)) continue;
          throw err;
        }
        await this.index(key);
        return stamped(created);
      }
      const current = parseSessionRecord(existing.stepState, key);
      const next = stamped(mutate(current));
      const cas = await this.store.replaceStepState(
        id,
        stepStateFingerprint(existing.stepState),
        next,
      );
      if (cas.won) return next;
    }
    throw rcError("AI1010", undefined, {
      message: `Agent session "${key.session}" of "${key.agent}" could not be written after ${CAS_ATTEMPTS} attempts: another writer kept winning the compare-and-swap.`,
    });
  }

  /** Add the key to the index record, creating the index on first use. */
  private async index(key: AgentSessionKey): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = await this.store.get(INDEX_ID);
      if (!existing) {
        const created: SessionIndex = {
          kind: "agent-session-index",
          keys: [key],
        };
        try {
          await this.store.create({
            ...placeholderFields(INDEX_ID, key),
            stepState: created,
          });
          return;
        } catch (err) {
          if (isAlreadyExists(err)) continue;
          throw err;
        }
      }
      const current = parseIndex(existing.stepState);
      if (
        current.keys.some(
          (k) => k.agent === key.agent && k.session === key.session,
        )
      ) {
        return;
      }
      const cas = await this.store.replaceStepState(
        INDEX_ID,
        stepStateFingerprint(existing.stepState),
        { ...current, keys: [...current.keys, key] } satisfies SessionIndex,
      );
      if (cas.won) return;
    }
    throw rcError("AI1010", undefined, {
      message: `The agent session index could not be written after ${CAS_ATTEMPTS} attempts.`,
    });
  }
}

function emptyRecord(key: AgentSessionKey): AgentSessionRecord {
  const now = new Date().toISOString();
  return {
    kind: "agent-session",
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
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5044"
  );
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
