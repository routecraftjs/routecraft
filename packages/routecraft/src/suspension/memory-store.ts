import { rcError } from "../error.ts";
import { encodePersistable } from "./serialize.ts";
import type {
  ExpiredScanCursor,
  NewSuspension,
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

  async create(record: NewSuspension): Promise<void> {
    if (this.#records.has(record.id)) {
      throw rcError("RC5044", undefined, {
        message: `Suspension "${record.id}" already exists in the store.`,
      });
    }
    // Built field by field rather than spread. The sqlite backend inserts
    // only the columns it names, so anything the caller carried in beyond the
    // creation fields leaves no trace there; a spread here would keep it
    // alive on a record that reports itself suspended, and the two backends
    // would stop being substitutable. `NewSuspension` types those fields
    // away, but a store is a persistence boundary and enforces its own
    // invariants rather than trusting the caller's compiler.
    this.#records.set(
      record.id,
      clone(
        normalise({
          id: record.id,
          routeId: record.routeId,
          position: record.position,
          continuationHash: record.continuationHash,
          actionFingerprint: record.actionFingerprint,
          exchange: record.exchange,
          schema: record.schema,
          ...(record.answer !== undefined ? { answer: record.answer } : {}),
          ...(record.key !== undefined ? { key: record.key } : {}),
          ...(record.callBinding !== undefined
            ? { callBinding: record.callBinding }
            : {}),
          ...(record.hasAuthorizer ? { hasAuthorizer: true } : {}),
          ...(record.question !== undefined
            ? { question: record.question }
            : {}),
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
          ...(record.stepState !== undefined
            ? { stepState: record.stepState }
            : {}),
          suspendedAt: record.suspendedAt,
          ...(record.expiresAt !== undefined
            ? { expiresAt: record.expiresAt }
            : {}),
          status: "suspended",
        }),
      ),
    );
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

  async claimExpiry(id: string, at: Date): Promise<SuspensionCasResult> {
    return this.#transition(id, { status: "expiring", claimedAt: at });
  }

  async markExpired(id: string): Promise<SuspensionCasResult> {
    return this.#transition(id, { status: "expired" }, "expiring");
  }

  async markDenied(id: string, reason?: string): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      {
        status: "denied",
        ...(reason !== undefined ? { deniedReason: reason } : {}),
      },
      "expiring",
    );
  }

  async releaseExpiring(before: Date): Promise<number> {
    let released = 0;
    for (const [id, record] of this.#records) {
      if (record.status !== "expiring") continue;
      if (
        record.claimedAt === undefined ||
        record.claimedAt.getTime() > before.getTime()
      ) {
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
      const { claimedAt: _claimedAt, ...rest } = record;
      this.#records.set(id, clone({ ...rest, status: "suspended" }));
      released++;
    }
    return released;
  }

  async recordTerminal(id: string, terminal: SerializedOutcome): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.set(
      id,
      clone({
        ...record,
        terminal: {
          ...terminal,
          ...(terminal.body !== undefined
            ? { body: encodePersistable(terminal.body, "terminal.body") }
            : {}),
        },
      }),
    );
  }

  /**
   * The shared shape of the suspendedAt-ordered queries: limit validation,
   * oldest first, an omitted limit meaning all of them, and a defensive
   * copy on the way out. The expiry scan orders by `(expiresAt, id)` for
   * its cursor and does not go through here.
   */
  #scan(
    matches: (record: Suspension) => boolean,
    limit?: number,
  ): Suspension[] {
    assertSweepLimit(limit);
    const found = [...this.#records.values()]
      .filter(matches)
      .sort((a, b) => a.suspendedAt.getTime() - b.suspendedAt.getTime());
    return (limit === undefined ? found : found.slice(0, limit)).map(clone);
  }

  async findExpired(
    now: Date,
    limit: number,
    after?: ExpiredScanCursor,
  ): Promise<Suspension[]> {
    assertSweepLimit(limit);
    assertScanCursor(after);
    const found = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "suspended" &&
          record.expiresAt !== undefined &&
          record.expiresAt.getTime() <= now.getTime() &&
          (after === undefined ||
            record.expiresAt.getTime() > after.expiresAt.getTime() ||
            (record.expiresAt.getTime() === after.expiresAt.getTime() &&
              compareIds(record.id, after.id) > 0)),
      )
      .sort(
        (a, b) =>
          (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0) ||
          compareIds(a.id, b.id),
      );
    return found.slice(0, limit).map(clone);
  }

  async resumedWithoutTerminal(limit?: number): Promise<Suspension[]> {
    return this.#scan(
      (record) => record.status === "resumed" && record.terminal === undefined,
      limit,
    );
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

  async purgeSettled(before: Date): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.#records) {
      // Terminal states by name, never "not suspended": `expiring` is a live
      // delivery claim, and purging one mid-delivery would strand the
      // finalize against a row that no longer exists.
      if (
        record.status !== "resumed" &&
        record.status !== "expired" &&
        record.status !== "denied"
      )
        continue;
      if (record.suspendedAt.getTime() >= before.getTime()) continue;
      this.#records.delete(id);
      purged++;
    }
    return purged;
  }

  /**
   * Releases nothing, because there is nothing to release. It deliberately
   * does NOT clear the records: `close()` means "release backend
   * resources" on every other backend, and a call that is a handle release
   * on sqlite but a data wipe here would make the two non-substitutable
   * for any code written against the interface. The map is collected with
   * the store. Use {@link MemorySuspensionStore.reset} to discard records.
   */
  async close(): Promise<void> {}

  /**
   * Discard every record. Not part of {@link SuspensionStore}: wiping is
   * specific to this backend, and a test wanting isolation should
   * construct a fresh store rather than rely on a method an arbitrary
   * backend may not have.
   */
  reset(): void {
    this.#records.clear();
  }

  /**
   * Compare-and-swap out of `from` (default `suspended`). Synchronous from
   * read to write so two concurrent callers cannot both observe the
   * pre-transition state.
   */
  #transition(
    id: string,
    fields: Partial<Suspension> & { status: Suspension["status"] },
    from: Suspension["status"] = "suspended",
  ): SuspensionCasResult {
    const record = this.#records.get(id);
    if (!record) return { won: false, suspension: undefined };
    if (record.status !== from) {
      return { won: false, suspension: clone(record) };
    }
    // `fields` carries caller-owned values (a `Date`, a `PrincipalRef`), so
    // the stored copy has to be detached too, not just the returned one.
    const stored = clone({ ...record, ...fields } as Suspension);
    this.#records.set(id, stored);
    return { won: true, suspension: clone(stored) };
  }
}

/**
 * Reject a `limit` the two backends would read differently. Exported so the
 * sqlite backend applies the identical rule.
 *
 * @internal
 */
export function assertSweepLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw rcError("RC5044", undefined, {
      message: `The scan limit must be a positive integer; received ${String(limit)}.`,
    });
  }
}

/**
 * Reject a cursor a backend would have to guess at. Exported for the same
 * reason as {@link assertSweepLimit}: both backends apply the identical
 * rule.
 *
 * @internal
 */
export function assertScanCursor(after: ExpiredScanCursor | undefined): void {
  if (after === undefined) return;
  if (
    !(after.expiresAt instanceof Date) ||
    Number.isNaN(after.expiresAt.getTime()) ||
    typeof after.id !== "string" ||
    after.id.length === 0
  ) {
    throw rcError("RC5044", undefined, {
      message:
        "findExpired() cursor must carry a valid expiresAt Date and a non-empty id.",
    });
  }
}

/**
 * Code-unit comparison, deliberately not `localeCompare`: the cursor needs
 * a stable strict order, and locale collation can change between runtimes.
 *
 * @internal
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Put the record's free-form slots through the same JSON-data rules the
 * durable backend applies, so a deployment that fell back to memory sees
 * identical values to one that did not. `structuredClone` alone would keep
 * shapes sqlite cannot store, and the divergence would only appear once a
 * driver was installed.
 *
 * @internal
 */
function normalise(record: Suspension): Suspension {
  return record.stepState === undefined
    ? record
    : {
        ...record,
        stepState: encodePersistable(record.stepState, "stepState"),
      };
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
