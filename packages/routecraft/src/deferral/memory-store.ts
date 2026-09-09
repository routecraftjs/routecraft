import { rcError } from "../error.ts";
import { compareCodeUnits } from "../shared/compare.ts";
import { stepStateFingerprint } from "./hash.ts";
import { encodePersistable } from "./serialize.ts";
import type {
  ExpiredScanCursor,
  NewDeferral,
  PendingDeferralSummary,
  SerializedOutcome,
  Deferral,
  DeferralCasResult,
  DeferralResumption,
  DeferralStore,
} from "./types.ts";

/**
 * In-process deferral store.
 *
 * The default under `testContext()` and the fallback when no durable
 * backend is available. Everything it holds dies with the process, so it is
 * the right choice for tests and for a route whose deferrals are
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
export class MemoryDeferralStore implements DeferralStore {
  readonly #records = new Map<string, Deferral>();

  /**
   * The live record map, bypassing the transitions and the clone-on-read
   * boundary. A test seam: the purge contract must hold for states the
   * public transitions cannot produce (a terminal record with no
   * `settledAt`), and proving that on this backend requires injecting one.
   * Sqlite's equivalent seam is raw SQL against the database file.
   *
   * @internal
   */
  static unsafeRecords(store: MemoryDeferralStore): Map<string, Deferral> {
    return store.#records;
  }

  async create(record: NewDeferral): Promise<void> {
    if (this.#records.has(record.id)) {
      throw rcError("RC5044", undefined, {
        message: `Deferral "${record.id}" already exists in the store.`,
      });
    }
    // Built field by field rather than spread. The sqlite backend inserts
    // only the columns it names, so anything the caller carried in beyond the
    // creation fields leaves no trace there; a spread here would keep it
    // alive on a record that reports itself deferred, and the two backends
    // would stop being substitutable. `NewDeferral` types those fields
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
          ...(record.callBinding !== undefined
            ? { callBinding: record.callBinding }
            : {}),
          ...(record.meta !== undefined ? { meta: record.meta } : {}),
          ...(record.stepState !== undefined
            ? { stepState: record.stepState }
            : {}),
          deferredAt: record.deferredAt,
          ...(record.expiresAt !== undefined
            ? { expiresAt: record.expiresAt }
            : {}),
          status: "deferred",
        }),
      ),
    );
  }

  async get(id: string): Promise<Deferral | undefined> {
    const record = this.#records.get(id);
    return record ? clone(record) : undefined;
  }

  async markResumed(
    id: string,
    resumption: DeferralResumption,
  ): Promise<DeferralCasResult> {
    return this.#transition(id, {
      status: "resumed",
      resumedAt: resumption.at,
      settledAt: resumption.at,
      ...(resumption.by ? { resumedBy: resumption.by } : {}),
    });
  }

  async claimExpiry(id: string, at: Date): Promise<DeferralCasResult> {
    return this.#transition(id, { status: "expiring", claimedAt: at });
  }

  async markExpired(id: string): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      { status: "expired", settledAt: new Date() },
      "expiring",
    );
  }

  async markDenied(id: string, reason?: string): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      {
        status: "denied",
        settledAt: new Date(),
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
      this.#records.set(id, clone({ ...rest, status: "deferred" }));
      released++;
    }
    return released;
  }

  async replaceStepState(
    id: string,
    expected: string,
    stepState: unknown,
  ): Promise<DeferralCasResult> {
    // Before the compare, matching the sqlite backend, so an unpersistable
    // replacement is RC5042 on both rather than RC5042 on one and a quiet
    // `won: false` on the other. The slot is free-form, so a caller can hand
    // back a value the durable backend would refuse, and finding that out
    // only after a failover is the bug this avoids.
    const encoded = encodePersistable(stepState, "stepState");
    const record = this.#records.get(id);
    if (!record) return { won: false, deferral: undefined };
    if (
      record.status !== "deferred" ||
      stepStateFingerprint(record.stepState) !== expected
    ) {
      return { won: false, deferral: clone(record) };
    }
    // Deleted rather than held as an undefined-valued key, so a cleared slot
    // reads back the same way it does from the durable backend, where the
    // column is NULL.
    const next = { ...record, stepState: encoded };
    if (encoded === undefined) delete next.stepState;
    const stored = clone(next);
    this.#records.set(id, stored);
    return { won: true, deferral: clone(stored) };
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
   * The shared shape of the deferredAt-ordered queries: limit validation,
   * oldest first, an omitted limit meaning all of them, and a defensive
   * copy on the way out. The expiry scan orders by `(expiresAt, id)` for
   * its cursor and does not go through here.
   */
  #scan(matches: (record: Deferral) => boolean, limit?: number): Deferral[] {
    assertSweepLimit(limit);
    const found = [...this.#records.values()]
      .filter(matches)
      .sort((a, b) => a.deferredAt.getTime() - b.deferredAt.getTime());
    return (limit === undefined ? found : found.slice(0, limit)).map(clone);
  }

  async findExpired(
    now: Date,
    limit: number,
    after?: ExpiredScanCursor,
  ): Promise<Deferral[]> {
    assertSweepLimit(limit);
    assertScanCursor(after);
    const found = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "deferred" &&
          record.expiresAt !== undefined &&
          record.expiresAt.getTime() <= now.getTime() &&
          (after === undefined ||
            record.expiresAt.getTime() > after.expiresAt.getTime() ||
            (record.expiresAt.getTime() === after.expiresAt.getTime() &&
              compareCodeUnits(record.id, after.id) > 0)),
      )
      .sort(
        (a, b) =>
          (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0) ||
          compareCodeUnits(a.id, b.id),
      );
    return found.slice(0, limit).map(clone);
  }

  async resumedWithoutTerminal(limit?: number): Promise<Deferral[]> {
    return this.#scan(
      (record) => record.status === "resumed" && record.terminal === undefined,
      limit,
    );
  }

  async pending(): Promise<PendingDeferralSummary> {
    let count = 0;
    let oldest: Date | undefined;
    for (const record of this.#records.values()) {
      if (record.status !== "deferred") continue;
      count++;
      if (!oldest || record.deferredAt.getTime() < oldest.getTime()) {
        oldest = record.deferredAt;
      }
    }
    return { count, ...(oldest ? { oldest: new Date(oldest.getTime()) } : {}) };
  }

  async purgeSettled(before: Date): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.#records) {
      // Terminal states by name, never "not deferred": `expiring` is a live
      // delivery claim, and purging one mid-delivery would strand the
      // finalize against a row that no longer exists.
      if (
        record.status !== "resumed" &&
        record.status !== "expired" &&
        record.status !== "denied"
      )
        continue;
      // A terminal record without settledAt is only reachable by injection
      // around the transitions. Skipped, never dated by fallback: sqlite's
      // NULL comparison skips the same row, and refusing to delete a record
      // you cannot date beats purging it on the clock #634 removed.
      if (record.settledAt === undefined) continue;
      if (record.settledAt.getTime() >= before.getTime()) continue;
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
   * the store. Use {@link MemoryDeferralStore.reset} to discard records.
   */
  async close(): Promise<void> {}

  /**
   * Discard every record. Not part of {@link DeferralStore}: wiping is
   * specific to this backend, and a test wanting isolation should
   * construct a fresh store rather than rely on a method an arbitrary
   * backend may not have.
   */
  reset(): void {
    this.#records.clear();
  }

  /**
   * Compare-and-swap out of `from` (default `deferred`). Synchronous from
   * read to write so two concurrent callers cannot both observe the
   * pre-transition state.
   */
  #transition(
    id: string,
    fields: Partial<Deferral> & { status: Deferral["status"] },
    from: Deferral["status"] = "deferred",
  ): DeferralCasResult {
    const record = this.#records.get(id);
    if (!record) return { won: false, deferral: undefined };
    if (record.status !== from) {
      return { won: false, deferral: clone(record) };
    }
    // `fields` carries caller-owned values (a `Date`, a `PrincipalRef`), so
    // the stored copy has to be detached too, not just the returned one.
    const stored = clone({ ...record, ...fields } as Deferral);
    this.#records.set(id, stored);
    return { won: true, deferral: clone(stored) };
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
 * Put the record's free-form slots through the same JSON-data rules the
 * durable backend applies, so a deployment that fell back to memory sees
 * identical values to one that did not. `structuredClone` alone would keep
 * shapes sqlite cannot store, and the divergence would only appear once a
 * driver was installed.
 *
 * @internal
 */
function normalise(record: Deferral): Deferral {
  return {
    ...record,
    ...(record.stepState !== undefined
      ? { stepState: encodePersistable(record.stepState, "stepState") }
      : {}),
    ...(record.meta !== undefined
      ? { meta: encodePersistable(record.meta, "meta") }
      : {}),
  };
}

/**
 * Detach a record from the caller. `structuredClone` preserves the `Date`
 * fields the record carries, which a JSON round trip would flatten to
 * strings.
 *
 * @internal
 */
function clone(record: Deferral): Deferral {
  return structuredClone(record) as Deferral;
}
