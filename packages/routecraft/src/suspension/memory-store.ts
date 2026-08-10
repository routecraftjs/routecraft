import { rcError } from "../error.ts";
import type {
  PendingSuspensionSummary,
  SerializedOutcome,
  Suspension,
  SuspensionCasResult,
  SuspensionResumption,
  SuspensionStore,
} from "./types.ts";

/**
 * In-process suspension store.
 *
 * The default under `testContext()` and the fallback when no durable
 * backend is available. Everything it holds dies with the process, so it is
 * the right choice for tests and for a route whose suspensions are
 * genuinely ephemeral, and the wrong choice for the feature's headline
 * promise: an exchange parked here does not survive a restart. The store
 * factory logs a warning whenever it falls back to this backend for that
 * reason.
 *
 * Records are cloned on the way in and on the way out, so a caller cannot
 * reach into stored state through a reference it kept, and the backend
 * behaves like a real one that round-trips through storage.
 *
 * The compare-and-swap methods complete within a single event-loop turn
 * (they never await between reading the status and writing it), which is
 * what makes them atomic on this backend.
 */
export class MemorySuspensionStore implements SuspensionStore {
  readonly #records = new Map<string, Suspension>();

  async create(record: Suspension): Promise<void> {
    if (this.#records.has(record.id)) {
      throw rcError("RC5001", undefined, {
        message: `Suspension "${record.id}" already exists in the store.`,
      });
    }
    this.#records.set(record.id, clone(record));
  }

  async get(id: string): Promise<Suspension | undefined> {
    const record = this.#records.get(id);
    return record ? clone(record) : undefined;
  }

  async markResumed(
    id: string,
    resumption: SuspensionResumption,
  ): Promise<SuspensionCasResult> {
    return this.#transition(id, {
      status: "resumed",
      resumedAt: resumption.at,
      ...(resumption.by ? { resumedBy: resumption.by } : {}),
    });
  }

  async markExpired(id: string): Promise<SuspensionCasResult> {
    return this.#transition(id, { status: "expired" });
  }

  async markDenied(id: string, reason?: string): Promise<SuspensionCasResult> {
    return this.#transition(id, {
      status: "denied",
      ...(reason !== undefined ? { deniedReason: reason } : {}),
    });
  }

  async recordTerminal(id: string, terminal: SerializedOutcome): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.set(id, clone({ ...record, terminal }));
  }

  async findExpired(now: Date, limit?: number): Promise<Suspension[]> {
    const due = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "suspended" &&
          record.expiresAt !== undefined &&
          record.expiresAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => a.suspendedAt.getTime() - b.suspendedAt.getTime());
    const bounded = limit === undefined ? due : due.slice(0, limit);
    return bounded.map(clone);
  }

  async pending(): Promise<PendingSuspensionSummary> {
    let count = 0;
    let oldest: Date | undefined;
    for (const record of this.#records.values()) {
      if (record.status !== "suspended") continue;
      count++;
      if (!oldest || record.suspendedAt.getTime() < oldest.getTime()) {
        oldest = record.suspendedAt;
      }
    }
    return { count, ...(oldest ? { oldest: new Date(oldest.getTime()) } : {}) };
  }

  async close(): Promise<void> {
    this.#records.clear();
  }

  /**
   * Compare-and-swap out of `suspended`. Synchronous from read to write so
   * two concurrent callers cannot both observe `suspended`.
   */
  #transition(
    id: string,
    fields: Partial<Suspension> & { status: Suspension["status"] },
  ): SuspensionCasResult {
    const record = this.#records.get(id);
    if (!record) return { won: false, suspension: undefined };
    if (record.status !== "suspended") {
      return { won: false, suspension: clone(record) };
    }
    const next = { ...record, ...fields } as Suspension;
    this.#records.set(id, next);
    return { won: true, suspension: clone(next) };
  }
}

/**
 * Detach a record from the caller. `structuredClone` preserves the `Date`
 * fields the record carries, which a JSON round trip would flatten to
 * strings.
 *
 * @internal
 */
function clone(record: Suspension): Suspension {
  return structuredClone(record) as Suspension;
}
