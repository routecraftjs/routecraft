import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { rcError } from "../../error.ts";
import { isRoutecraftError } from "../../brand.ts";
import { stepStateFingerprint } from "../../kernel/continuation/hash.ts";
import { encodePersistable } from "../../kernel/continuation/serialize.ts";
import {
  assertListCursor,
  assertScanCursor,
  assertSweepLimit,
} from "./memory-store.ts";
import {
  type ResolvedSqliteDriver,
  type SqliteDatabase,
  type SqliteDriverLoaders,
  resolveSqliteDriver,
} from "../../shared/sqlite/driver.ts";
import {
  describeSqliteFile,
  isSqliteBusy,
  migrateSqlite,
  resolveDatabasePath,
  SQLITE_APPLICATION_IDS,
} from "../../shared/sqlite/database.ts";
import {
  claimIsOutstanding,
  claimResultOf,
} from "../../kernel/continuation/types.ts";
import type {
  ErrorPathRecord,
  ExpiredScanCursor,
  NewDeferral,
  PendingDeferralSummary,
  PrincipalRef,
  SerializedExchange,
  SerializedOutcome,
  Deferral,
  DeferralCasResult,
  DeferralClaim,
  DeferralClaimId,
  DeferralClaimResult,
  DeferralListQuery,
  DeferralOutcome,
  DeferralSchema,
  DeferralResumption,
  DeferralState,
  DeferralStore,
  DeferralSummary,
  DeferralWaitingFor,
} from "../../kernel/continuation/types.ts";

/**
 * Default location of the deferral database, relative to the working
 * directory. Deployments that mount a volume (the Docker showcase does)
 * override it via `deferral: { store: { path } }` or
 * `ROUTECRAFT_DEFERRAL_STORE`.
 */
export const DEFAULT_DEFERRAL_DB_PATH = ".routecraft/deferrals.db";

/**
 * Names this subsystem in the absent-peer error, so a Node deployment
 * missing `better-sqlite3` reads which feature asked for it.
 */
const SQLITE_CONSUMER = "deferral store (sqlite)";

/**
 * Schema version this build writes. Bumped whenever
 * {@link MIGRATIONS} grows an entry.
 */
const SCHEMA_VERSION = 3;

/**
 * How long a writer waits for a competing write lock before giving up.
 * Set explicitly because the two drivers ship different defaults.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The resumable compare, spelled once. `resumable()` in `types.ts` is the
 * same condition in TypeScript, and the memory backend uses that; a store
 * whose `WHERE` clause drifted from it would accept a resume the other
 * backend refuses.
 */
const RESUMABLE = "state = 'waiting' AND claimed_at IS NULL";

/**
 * The fenced compare, the other half of {@link RESUMABLE}: a waiting record
 * whose live claim is the one the caller presents. `claimedBy()` in
 * `types.ts` is the same condition in TypeScript. The `claimed_at` test is
 * implied by a non-null `claim_id` and kept anyway, so the clause reads as
 * what it checks.
 */
const CLAIMED_BY =
  "state = 'waiting' AND claimed_at IS NOT NULL AND claim_id = ?";

/**
 * Forward-only migrations, applied in order from the database's current
 * `PRAGMA user_version` to {@link SCHEMA_VERSION}. Index `n` migrates from
 * version `n` to `n + 1`, so a fresh file (version 0) runs all of them and
 * an up-to-date one runs none. This is what makes first run safe: opening
 * the store creates its own schema, there is no separate migrate step to
 * forget.
 *
 * `deferrals_pending` carries `id` as its last column so it serves the
 * management listing's `(deferred_at, id)` keyset as well as `pending()`,
 * and `deferrals_listing` serves the same ordering with `state` unbound,
 * which is what `?state=all` and a route-only filter ask for: without it
 * that path is a full scan plus a temp sort of every surviving row, per
 * page, on a table that holds every deferral until retention takes it.
 * Both folded into version 1 rather than added as version 2 for the same
 * reason the canary chain is not carried: no released build has written
 * this file yet.
 *
 * Version 1 is the first shape a release ever wrote. The chain that built it
 * across the 0.7.0 canary is deliberately not carried: no released build
 * produced those files, and keeping the steps would preserve the retired
 * vocabulary in table and column names an operator only meets by opening the
 * database. Version 2 IS carried, for the opposite reason: a released build
 * has written version 1 files, and an operator's existing deferrals have to
 * survive the upgrade.
 *
 * Timestamps are stored as epoch milliseconds rather than SQLite datetimes
 * so ordering and comparison work without a date function, and JSON columns
 * hold the already-serialized exchange, so the store never re-encodes what
 * `serializeExchange` produced.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE deferrals (
     id                 TEXT PRIMARY KEY,
     route_id           TEXT    NOT NULL,
     position           INTEGER NOT NULL,
     continuation_hash  TEXT    NOT NULL,
     action_fingerprint TEXT    NOT NULL,
     exchange           TEXT    NOT NULL,
     "schema"           TEXT    NOT NULL,
     step_state         TEXT,
     state              TEXT    NOT NULL,
     waiting_for        TEXT    NOT NULL,
     deferred_at        INTEGER NOT NULL,
     expires_at         INTEGER,
     claimed_at         INTEGER,
     outcome_kind       TEXT,
     outcome_at         INTEGER,
     outcome_reason     TEXT,
     outcome_by         TEXT,
     continuation       TEXT,
     call_binding       TEXT,
     meta               TEXT
   );
   CREATE INDEX deferrals_sweep ON deferrals (state, claimed_at, expires_at, id);
   CREATE INDEX deferrals_pending ON deferrals (state, deferred_at, id);
   CREATE INDEX deferrals_listing ON deferrals (deferred_at, id);
   CREATE INDEX deferrals_by_route ON deferrals (route_id, deferred_at, id);
   CREATE INDEX deferrals_retention ON deferrals (state, outcome_at);
   CREATE INDEX deferrals_stranded ON deferrals (outcome_kind, deferred_at);`,
  // Version 2: error-path park metadata. Unindexed: only ever read by id.
  `ALTER TABLE deferrals ADD COLUMN error_path TEXT;`,
  // Version 3: the claim gains an identity and a renewal time. A claim a
  // version 2 build left outstanding gets both, so the invariant that a
  // claimed row carries all three columns holds for every row the store
  // will ever read; its holder is gone (this process replaced it), so the
  // lease releases it as usual.
  `ALTER TABLE deferrals ADD COLUMN claim_id TEXT;
   ALTER TABLE deferrals ADD COLUMN claim_renewed_at INTEGER;
   UPDATE deferrals
      SET claim_id = lower(hex(randomblob(16))), claim_renewed_at = claimed_at
    WHERE claimed_at IS NOT NULL;`,
];

/**
 * Durable deferral store on SQLite.
 *
 * One implementation over two drivers: `bun:sqlite` under Bun and
 * `better-sqlite3` under Node. Both are synchronous, which is what makes
 * the compare-and-swap methods genuinely atomic here: a single `UPDATE
 * ... WHERE state = 'waiting' AND claimed_at IS NULL` either changes one row
 * or none, and the driver returns which. See `shared/sqlite/driver.ts` for the runtime-split
 * decision, the version matrix behind it, and the graduation condition for
 * `node:sqlite`.
 *
 * Open it with {@link SqliteDeferralStore.open}; the constructor is
 * private because a store is only usable after its schema has been
 * migrated.
 */
export class SqliteDeferralStore implements DeferralStore {
  readonly #db: SqliteDatabase;

  /** Which driver backs this store. Surfaced for logging and tests. */
  readonly driver: ResolvedSqliteDriver["name"];

  #closed = false;

  private constructor(
    db: SqliteDatabase,
    driver: ResolvedSqliteDriver["name"],
  ) {
    this.#db = db;
    this.driver = driver;
  }

  /**
   * Open (creating if absent) the deferral database and bring its schema
   * up to date.
   *
   * @param options.path - Database file path, absolute or relative to the
   *   working directory. `":memory:"` opens a private in-process database,
   *   which is useful for exercising the sqlite code paths in tests without
   *   touching disk.
   * @param options.loaders - Driver loader injection point for tests.
   * @throws RC5017 under Node when `better-sqlite3` is not installed.
   */
  static async open(options: {
    path: string;
    loaders?: SqliteDriverLoaders;
  }): Promise<SqliteDeferralStore> {
    const driver = await resolveSqliteDriver(SQLITE_CONSUMER, options.loaders);
    const path = resolveDatabasePath(options.path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const db = new driver.Database(path);
    try {
      initialise(db);
    } catch (cause) {
      // No store owns the handle yet, and an unclosed one leaves the file locked.
      try {
        db.close();
      } catch {
        // Already unusable; the original cause is what matters.
      }
      throw cause;
    }
    return new SqliteDeferralStore(db, driver.name);
  }

  async create(record: NewDeferral): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO deferrals (
             id, route_id, position, continuation_hash, action_fingerprint,
             exchange, "schema", call_binding, meta, error_path,
             step_state, state, waiting_for, deferred_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.routeId,
          record.position,
          record.continuationHash,
          record.actionFingerprint,
          JSON.stringify(record.exchange),
          JSON.stringify(record.schema),
          record.callBinding ?? null,
          record.meta === undefined
            ? null
            : JSON.stringify(encodePersistable(record.meta, "meta")),
          // Framework-owned plain JSON with no user value, so no `encodePersistable`.
          record.errorPath === undefined
            ? null
            : JSON.stringify(record.errorPath),
          record.stepState === undefined
            ? null
            : JSON.stringify(encodePersistable(record.stepState, "stepState")),
          "waiting" satisfies DeferralState,
          record.waitingFor,
          record.deferredAt.getTime(),
          record.expiresAt ? record.expiresAt.getTime() : null,
        );
    } catch (cause) {
      // RC5042 passes through unwrapped, as the memory backend reports it.
      if (isRoutecraftError(cause)) throw cause;
      // A duplicate id is a derivation bug no retry fixes, so it must not be retryable.
      const duplicate = /UNIQUE constraint failed/i.test(
        cause instanceof Error ? cause.message : String(cause),
      );
      if (isSqliteBusy(cause)) {
        throw rcError("RC5045", cause, {
          message: `The deferral store was busy while persisting "${record.id}".`,
        });
      }
      throw rcError("RC5044", cause, {
        message: duplicate
          ? `Deferral "${record.id}" already exists in the store.`
          : `Failed to persist deferral "${record.id}" to the sqlite store.`,
      });
    }
  }

  async get(id: string): Promise<Deferral | undefined> {
    return guard(`read deferral "${id}"`, () => {
      const row = this.#db
        .prepare(`SELECT * FROM deferrals WHERE id = ?`)
        .get(id);
      return row ? toDeferral(row as DeferralRow) : undefined;
    });
  }

  async markResumed(
    id: string,
    resumption: DeferralResumption,
  ): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      `UPDATE deferrals
          SET state = 'settled', outcome_kind = 'resumed',
              outcome_at = ?, outcome_by = ?
        WHERE id = ? AND ${RESUMABLE}`,
      [
        resumption.at.getTime(),
        resumption.by ? JSON.stringify(resumption.by) : null,
        id,
      ],
    );
  }

  async claimExpiry(id: string, at: Date): Promise<DeferralClaimResult> {
    return claimResultOf(
      this.#transition(
        id,
        `UPDATE deferrals
            SET claimed_at = ?, claim_id = ?, claim_renewed_at = ?
          WHERE id = ? AND ${RESUMABLE}`,
        [at.getTime(), randomUUID(), at.getTime(), id],
      ),
    );
  }

  async renewClaim(
    id: string,
    claimId: DeferralClaimId,
    at: Date,
  ): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      `UPDATE deferrals SET claim_renewed_at = ?
        WHERE id = ? AND ${CLAIMED_BY}`,
      [at.getTime(), id, claimId],
    );
  }

  async markExpired(
    id: string,
    claimId: DeferralClaimId,
  ): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      `UPDATE deferrals
          SET state = 'settled', outcome_kind = 'expired', outcome_at = ?
        WHERE id = ? AND ${CLAIMED_BY}`,
      [Date.now(), id, claimId],
    );
  }

  async markDenied(
    id: string,
    claimId: DeferralClaimId,
    reason?: string,
  ): Promise<DeferralCasResult> {
    return this.#transition(
      id,
      `UPDATE deferrals
          SET state = 'settled', outcome_kind = 'denied',
              outcome_reason = ?, outcome_at = ?
        WHERE id = ? AND ${CLAIMED_BY}`,
      [reason ?? null, Date.now(), id, claimId],
    );
  }

  /**
   * The lease is measured from `claimed_at` where a row has no renewal
   * time: a 0.7 build still holding the file open after a 0.8 build
   * migrated it writes claims without the version 3 columns, and a compare
   * on `claim_renewed_at` alone would never release them.
   */
  async releaseClaims(before: Date): Promise<number> {
    return guard("release stale delivery claims", () => {
      this.#db
        .prepare(
          `UPDATE deferrals
              SET claimed_at = NULL, claim_id = NULL, claim_renewed_at = NULL
            WHERE state = 'waiting'
              AND COALESCE(claim_renewed_at, claimed_at) <= ?`,
        )
        .run(before.getTime());
      return (
        this.#db.prepare("SELECT changes() AS changed").get() as {
          changed: number;
        }
      ).changed;
    });
  }

  /**
   * Unlike the `mark*` transitions this cannot be one conditional `UPDATE`:
   * the compare is a digest of a JSON column, which SQLite cannot compute.
   * The read and the write therefore share one `BEGIN IMMEDIATE`, which
   * takes the write lock at the read, so no other connection can move the
   * row in between. That is the same guarantee the single-statement form
   * gives, bought with a lock held for one extra statement.
   */
  async replaceStepState(
    id: string,
    expected: string,
    stepState: unknown,
  ): Promise<DeferralCasResult> {
    // Outside the transaction: RC5042 here is the caller's bug, not a store failure.
    const encoded = encodePersistable(stepState, "stepState");
    let won = false;
    let row: unknown;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const current = this.#db
        .prepare(
          `SELECT state, claimed_at, step_state FROM deferrals WHERE id = ?`,
        )
        .get(id) as
        | {
            state: string;
            claimed_at: number | null;
            step_state: string | null;
          }
        | undefined
        | null;
      if (
        current != null &&
        current.state === "waiting" &&
        current.claimed_at === null &&
        stepStateFingerprint(
          current.step_state === null
            ? undefined
            : (JSON.parse(current.step_state) as unknown),
        ) === expected
      ) {
        this.#db
          .prepare(
            `UPDATE deferrals SET step_state = ?
             WHERE id = ? AND ${RESUMABLE}`,
          )
          // bun:sqlite binds undefined as NULL; better-sqlite3 rejects it.
          .run(encoded === undefined ? null : JSON.stringify(encoded), id);
        won =
          (
            this.#db.prepare("SELECT changes() AS changed").get() as {
              changed: number;
            }
          ).changed === 1;
      }
      row = this.#db.prepare(`SELECT * FROM deferrals WHERE id = ?`).get(id);
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // BEGIN itself failed, so there is no transaction to roll back.
      }
      throw rcError(isSqliteBusy(cause) ? "RC5045" : "RC5044", cause, {
        message: `Failed to replace the step state of deferral "${id}" in the sqlite store.`,
      });
    }
    return {
      won,
      deferral: row ? toDeferral(row as DeferralRow) : undefined,
    };
  }

  async recordContinuation(
    id: string,
    continuation: SerializedOutcome,
  ): Promise<void> {
    guard(`record the continuation result of "${id}"`, () => {
      this.#db
        .prepare(`UPDATE deferrals SET continuation = ? WHERE id = ?`)
        .run(JSON.stringify(serializeContinuation(continuation)), id);
    });
  }

  async findExpired(
    now: Date,
    limit: number,
    after?: ExpiredScanCursor,
  ): Promise<Deferral[]> {
    assertSweepLimit(limit);
    assertScanCursor(after);
    return guard("scan for expired deferrals", () => {
      // The expanded `(a > x OR (a = x AND b > y))` form rather than
      // row-value syntax, which would put a floor on the SQLite version.
      const rows = after
        ? this.#db
            .prepare(
              `SELECT * FROM deferrals
                WHERE ${RESUMABLE}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ?
                  AND (expires_at > ? OR (expires_at = ? AND id > ?))
                ORDER BY expires_at ASC, id ASC
                LIMIT ?`,
            )
            .all(
              now.getTime(),
              after.expiresAt.getTime(),
              after.expiresAt.getTime(),
              after.id,
              limit,
            )
        : this.#db
            .prepare(
              `SELECT * FROM deferrals
                WHERE ${RESUMABLE}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ?
                ORDER BY expires_at ASC, id ASC
                LIMIT ?`,
            )
            .all(now.getTime(), limit);
      return rows.map((row) => toDeferral(row as DeferralRow));
    });
  }

  async list(query: DeferralListQuery): Promise<DeferralSummary[]> {
    assertSweepLimit(query.limit);
    assertListCursor(query.after);
    return guard("list deferrals", () => {
      // Only the summary's own columns, so a page never reads a serialized
      // exchange out of the database to then drop it.
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (query.state !== undefined) {
        where.push("state = ?");
        params.push(query.state);
      }
      if (query.routeId !== undefined) {
        where.push("route_id = ?");
        params.push(query.routeId);
      }
      if (query.after !== undefined) {
        // Expanded rather than row-value syntax, matching findExpired: the
        // latter puts a floor on the SQLite version.
        where.push("(deferred_at > ? OR (deferred_at = ? AND id > ?))");
        params.push(
          query.after.deferredAt.getTime(),
          query.after.deferredAt.getTime(),
          query.after.id,
        );
      }
      const rows = this.#db
        .prepare(
          `SELECT id, route_id, state, waiting_for, deferred_at, expires_at,
                  claimed_at, outcome_kind, outcome_at, outcome_reason, outcome_by
             FROM deferrals
             ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY deferred_at ASC, id ASC
             LIMIT ?`,
        )
        .all(...params, query.limit);
      return rows.map((row) => toSummary(row as DeferralSummaryRow));
    });
  }

  async resumedWithoutContinuation(limit?: number): Promise<Deferral[]> {
    assertSweepLimit(limit);
    return guard("scan for stranded resumes", () => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM deferrals
          WHERE outcome_kind = 'resumed'
            AND continuation IS NULL
          ORDER BY deferred_at ASC
          LIMIT ?`,
        )
        .all(limit ?? -1);
      return rows.map((row) => toDeferral(row as DeferralRow));
    });
  }

  async pending(): Promise<PendingDeferralSummary> {
    return guard("summarise pending deferrals", () => {
      const row = this.#db
        .prepare(
          `SELECT COUNT(*) AS count, MIN(deferred_at) AS oldest
           FROM deferrals WHERE state = 'waiting'`,
        )
        .get() as { count: number; oldest: number | null } | undefined;
      const count = row?.count ?? 0;
      return {
        count,
        ...(row?.oldest != null ? { oldest: new Date(row.oldest) } : {}),
      };
    });
  }

  async purgeSettled(before: Date): Promise<number> {
    return guard("purge settled deferrals", () => {
      this.#db
        .prepare(
          `DELETE FROM deferrals
          WHERE state = 'settled'
            AND outcome_at < ?`,
        )
        .run(before.getTime());
      return (
        this.#db.prepare("SELECT changes() AS changed").get() as {
          changed: number;
        }
      ).changed;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /**
   * Run a conditional `UPDATE` that only matches a row in the state the
   * caller expected, and report whether this caller performed it.
   *
   * The update and the read-back run inside one immediate transaction so
   * the returned record is the state this transition produced, not a state
   * some later writer moved on to. The {@link RESUMABLE} or
   * {@link CLAIMED_BY} clause is the compare half of the compare-and-swap;
   * `changes` is the answer. `params` binds every `?` in `sql`, the id
   * included, in order.
   */
  #transition(id: string, sql: string, params: unknown[]): DeferralCasResult {
    let won = false;
    let row: unknown;
    try {
      // BEGIN sits inside the try so a busy lock surfaces as the wrapped
      // store error this method promises, not as a raw driver throw.
      this.#db.exec("BEGIN IMMEDIATE");
      this.#db.prepare(sql).run(...params);
      // bun:sqlite's run() only returns { changes } from partway through 1.1.
      won =
        (
          this.#db.prepare("SELECT changes() AS changed").get() as {
            changed: number;
          }
        ).changed === 1;
      row = this.#db.prepare(`SELECT * FROM deferrals WHERE id = ?`).get(id);
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // BEGIN itself failed, so there is no transaction to roll back.
        // The original cause is the one worth reporting.
      }
      throw rcError(isSqliteBusy(cause) ? "RC5045" : "RC5044", cause, {
        message: `Failed to transition deferral "${id}" in the sqlite store.`,
      });
    }
    // Outside the try: a rollback with no transaction would mask a parse failure.
    return {
      won,
      deferral: row ? toDeferral(row as DeferralRow) : undefined,
    };
  }
}

/**
 * Configure the connection and bring its schema up to date. Split out of
 * `open` so a failure here can be caught while the handle is still in
 * scope and closed.
 *
 * @internal
 */
function initialise(db: SqliteDatabase): void {
  // WAL lets the sweeper read while a resume writes. Harmless on
  // `:memory:`, where SQLite ignores the journal mode change.
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3 defaults busy_timeout to 5s, bun:sqlite to 0.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
}

/**
 * Apply outstanding migrations, mapping a refusal onto the store's own
 * code. The transaction and the version handling are shared with every
 * other sqlite store in the repository.
 *
 * @internal
 */
function migrate(db: SqliteDatabase): void {
  migrateSqlite(db, {
    schemaVersion: SCHEMA_VERSION,
    migrations: MIGRATIONS,
    applicationId: SQLITE_APPLICATION_IDS.deferral,
    identityTable: "deferrals",
    onFailure: (failure) => {
      if (failure.kind === "foreign") {
        return rcError("RC5044", undefined, {
          message: `This file is not a deferral store; ${describeSqliteFile(failure)}. Point deferral.store.path at its own file: every store keeps one, and they cannot share. A 0.7.0 canary's own database also arrives here when its configured path was carried over unchanged, because the store's identity moved with the rename: delete that file or name a new path, since canary records are not carried into the release.`,
        });
      }
      if (failure.kind === "downgrade") {
        return rcError("RC5044", undefined, {
          message: `Deferral store schema version ${failure.current} is newer than this build understands (${SCHEMA_VERSION}). Run the newer Routecraft build, or point deferral.store.path at a fresh file.`,
        });
      }
      return rcError("RC5044", failure.cause, {
        message: "Failed to migrate the deferral store schema.",
      });
    },
  });
}

/**
 * Run a store operation, mapping any driver or decode failure onto the
 * store's own codes. Without this the read paths surfaced raw driver errors
 * and raw `SyntaxError`s from a corrupt column, so a caller could not tell a
 * retryable busy lock from a permanent fault.
 *
 * @internal
 */
function guard<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    if (isRoutecraftError(cause)) throw cause;
    throw rcError(isSqliteBusy(cause) ? "RC5045" : "RC5044", cause, {
      message: `Failed to ${what} in the sqlite store.`,
    });
  }
}

/**
 * Row shape as the drivers return it. Both produce plain objects with
 * snake_case column names.
 *
 * @internal
 */
interface DeferralRow {
  id: string;
  route_id: string;
  position: number;
  continuation_hash: string;
  action_fingerprint: string;
  exchange: string;
  schema: string;
  call_binding: string | null;
  meta: string | null;
  // Nullable-or-absent: a row written before the version 2 migration has no
  // value, and a driver reading a freshly added column can report either.
  error_path?: string | null;
  step_state: string | null;
  state: string;
  waiting_for: string;
  deferred_at: number;
  expires_at: number | null;
  claimed_at: number | null;
  // Nullable-or-absent like `error_path`: both arrive with version 3.
  claim_id?: string | null;
  claim_renewed_at?: number | null;
  outcome_kind: string | null;
  outcome_at: number | null;
  outcome_reason: string | null;
  outcome_by: string | null;
  continuation: string | null;
}

/**
 * The columns the management listing selects. Derived from
 * {@link DeferralRow} rather than re-typed, so the column-to-type mapping
 * for this table lives once: the query names these so the exchange, the
 * step state and the schema are never read at all.
 */
type DeferralSummaryRow = Pick<
  DeferralRow,
  | "id"
  | "route_id"
  | "state"
  | "waiting_for"
  | "deferred_at"
  | "expires_at"
  | "claimed_at"
  | "outcome_kind"
  | "outcome_at"
  | "outcome_reason"
  | "outcome_by"
>;

/**
 * Hydrate the outcome half of a row, for the record and the summary alike.
 *
 * Both columns or neither. A row carrying one of them is only reachable by
 * raw SQL, and reading it back as a partial outcome would mean inventing
 * the missing half: a kind for a row that never settled, or a date the
 * retention sweep would then act on. Absent is what it is, and it is what
 * the memory backend produces for the same injection.
 *
 * @internal
 */
function toOutcome(row: DeferralSummaryRow): { outcome?: DeferralOutcome } {
  if (row.outcome_kind === null || row.outcome_at === null) return {};
  return {
    outcome: {
      kind: row.outcome_kind as DeferralOutcome["kind"],
      at: new Date(row.outcome_at),
      ...(row.outcome_reason !== null ? { reason: row.outcome_reason } : {}),
      ...(row.outcome_by !== null
        ? { by: JSON.parse(row.outcome_by) as PrincipalRef }
        : {}),
    },
  };
}

/**
 * Read a summary row.
 *
 * Not `summariseDeferral(toDeferral(row))`: the query deliberately does not
 * select the exchange, the schema or the step state, so there is no full
 * record here to summarise.
 *
 * @internal
 */
function toSummary(row: DeferralSummaryRow): DeferralSummary {
  return {
    id: row.id,
    routeId: row.route_id,
    state: row.state as DeferralState,
    waitingFor: row.waiting_for as DeferralWaitingFor,
    claimed: claimIsOutstanding(
      row.state as DeferralState,
      row.claimed_at === null ? null : new Date(row.claimed_at),
    ),
    deferredAt: new Date(row.deferred_at),
    ...(row.expires_at !== null ? { expiresAt: new Date(row.expires_at) } : {}),
    ...toOutcome(row),
  };
}

/**
 * Hydrate the claim half of a row.
 *
 * The store writes all three claim columns together, and the version 3
 * migration backfills the two it added. A claim timestamp with no identity
 * is a claim a 0.7 build wrote into a file a 0.8 build had already
 * migrated. It is read back as a claim with a synthesised identity, which
 * no holder was ever handed and which no `claim_id = ?` compare can match
 * against the NULL column, so nothing can renew or settle it under the
 * fence; {@link SqliteDeferralStore.releaseClaims} releases it once its
 * lease, measured from `claimed_at`, elapses.
 *
 * @internal
 */
function toClaim(row: DeferralRow): { claim?: DeferralClaim } {
  if (row.claimed_at === null) return {};
  return {
    claim: {
      id: (row.claim_id ??
        `legacy:${row.id}:${row.claimed_at}`) as DeferralClaimId,
      at: new Date(row.claimed_at),
      renewedAt: new Date(row.claim_renewed_at ?? row.claimed_at),
    },
  };
}

/** @internal */
function toDeferral(row: DeferralRow): Deferral {
  const continuation = row.continuation
    ? (JSON.parse(row.continuation) as SerializedOutcome & { at: string })
    : undefined;
  return {
    id: row.id,
    routeId: row.route_id,
    position: row.position,
    continuationHash: row.continuation_hash,
    actionFingerprint: row.action_fingerprint,
    exchange: JSON.parse(row.exchange) as SerializedExchange,
    schema: JSON.parse(row.schema) as DeferralSchema,
    ...(row.call_binding !== null ? { callBinding: row.call_binding } : {}),
    ...(row.meta !== null ? { meta: JSON.parse(row.meta) as unknown } : {}),
    ...(row.error_path != null
      ? { errorPath: JSON.parse(row.error_path) as ErrorPathRecord }
      : {}),
    ...(row.step_state !== null
      ? { stepState: JSON.parse(row.step_state) as unknown }
      : {}),
    state: row.state as DeferralState,
    waitingFor: row.waiting_for as DeferralWaitingFor,
    deferredAt: new Date(row.deferred_at),
    ...(row.expires_at !== null ? { expiresAt: new Date(row.expires_at) } : {}),
    ...toClaim(row),
    ...toOutcome(row),
    ...(continuation
      ? { continuation: { ...continuation, at: new Date(continuation.at) } }
      : {}),
  };
}

/**
 * `Date` does not survive `JSON.stringify` as a `Date`, so the continuation
 * result's timestamp is written as an ISO string and revived in
 * {@link toDeferral}.
 *
 * @internal
 */
function serializeContinuation(continuation: SerializedOutcome): unknown {
  return {
    ...continuation,
    ...(continuation.body !== undefined
      ? { body: encodePersistable(continuation.body, "continuation.body") }
      : {}),
    at: continuation.at.toISOString(),
  };
}
