import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { rcError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import { encodePersistable } from "./serialize.ts";
import { assertScanCursor, assertSweepLimit } from "./memory-store.ts";
import {
  type ResolvedSqliteDriver,
  type SqliteDatabase,
  type SqliteDriverLoaders,
  resolveSqliteDriver,
} from "../shared/sqlite/driver.ts";
import type {
  ExpiredScanCursor,
  NewSuspension,
  PendingSuspensionSummary,
  PrincipalRef,
  SerializedExchange,
  SerializedOutcome,
  Suspension,
  SuspensionCasResult,
  SuspensionSchema,
  SuspensionResumption,
  SuspensionStatus,
  SuspensionStore,
} from "./types.ts";

/**
 * Default location of the suspension database, relative to the working
 * directory. Deployments that mount a volume (the Docker showcase does)
 * override it via `suspension: { store: { path } }` or
 * `ROUTECRAFT_SUSPENSION_STORE`.
 */
export const DEFAULT_SUSPENSION_DB_PATH = ".routecraft/suspensions.db";

/**
 * Names this subsystem in the absent-peer error, so a Node deployment
 * missing `better-sqlite3` reads which feature asked for it.
 */
const SQLITE_CONSUMER = "suspension store (sqlite)";

/**
 * Schema version this build writes. Bumped whenever
 * {@link MIGRATIONS} grows an entry.
 */
const SCHEMA_VERSION = 4;

/**
 * How long a writer waits for a competing write lock before giving up.
 * Set explicitly because the two drivers ship different defaults.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Forward-only migrations, applied in order from the database's current
 * `PRAGMA user_version` to {@link SCHEMA_VERSION}. Index `n` migrates from
 * version `n` to `n + 1`, so a fresh file (version 0) runs all of them and
 * an up-to-date one runs none. This is what makes first run safe: opening
 * the store creates its own schema, there is no separate migrate step to
 * forget.
 *
 * Timestamps are stored as epoch milliseconds rather than SQLite datetimes
 * so ordering and comparison work without a date function, and JSON columns
 * hold the already-serialized exchange, so the store never re-encodes what
 * `serializeExchange` produced.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE suspensions (
     id                 TEXT PRIMARY KEY,
     route_id           TEXT    NOT NULL,
     position           INTEGER NOT NULL,
     continuation_hash  TEXT    NOT NULL,
     action_fingerprint TEXT    NOT NULL,
     exchange           TEXT    NOT NULL,
     expect             TEXT    NOT NULL,
     step_state         TEXT,
     status             TEXT    NOT NULL,
     suspended_at       INTEGER NOT NULL,
     expires_at         INTEGER,
     resumed_at         INTEGER,
     resumed_by         TEXT,
     denied_reason      TEXT,
     terminal           TEXT
   );
   CREATE INDEX suspensions_sweep ON suspensions (status, expires_at);
   CREATE INDEX suspensions_pending ON suspensions (status, suspended_at);`,
  // v2: the expiring delivery claim and the keyset sweep cursor. The sweep
  // index gains id so `(status, expires_at, id)` pages are index-served in
  // cursor order.
  `ALTER TABLE suspensions ADD COLUMN claimed_at INTEGER;
   DROP INDEX IF EXISTS suspensions_sweep;
   CREATE INDEX suspensions_sweep ON suspensions (status, expires_at, id);`,
  // v3: the per-call credential binding, and the `meta` slot the resume
  // route's authorize hook is handed. Both nullable: a record written
  // before this migration carried neither, and reading one back as such is
  // exactly right. `expect` becomes `schema` in the same step, so the
  // column and the field it carries stop drifting apart.
  `ALTER TABLE suspensions RENAME COLUMN "expect" TO "schema";
   ALTER TABLE suspensions ADD COLUMN call_binding TEXT;
   ALTER TABLE suspensions ADD COLUMN meta TEXT;`,
  // v4: the retention clock. Retention used to be measured from
  // suspended_at because no settlement timestamp existed, which purged a
  // record that parked for 89 days and settled on day 89 one day later.
  // Resumed rows backfill exactly from resumed_at. Expired and denied rows
  // carry no trustworthy settlement evidence (expires_at is when an expired
  // row came DUE, which a long outage puts far before the transition, and a
  // denied row's deadline says nothing about when it was denied), so they
  // take the migration moment and get one full retention window from the
  // upgrade: longer residence, never a purge earlier than the new contract
  // promises.
  `ALTER TABLE suspensions ADD COLUMN settled_at INTEGER;
   UPDATE suspensions SET settled_at = resumed_at WHERE status = 'resumed';
   UPDATE suspensions SET settled_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE status IN ('expired', 'denied');
   CREATE INDEX suspensions_retention ON suspensions (status, settled_at);`,
];

/**
 * Durable suspension store on SQLite.
 *
 * One implementation over two drivers: `bun:sqlite` under Bun and
 * `better-sqlite3` under Node. Both are synchronous, which is what makes
 * the compare-and-swap methods genuinely atomic here: a single `UPDATE
 * ... WHERE status = 'suspended'` either changes one row or none, and the
 * driver returns which. See `shared/sqlite/driver.ts` for the runtime-split
 * decision, the version matrix behind it, and the graduation condition for
 * `node:sqlite`.
 *
 * Open it with {@link SqliteSuspensionStore.open}; the constructor is
 * private because a store is only usable after its schema has been
 * migrated.
 */
export class SqliteSuspensionStore implements SuspensionStore {
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
   * Open (creating if absent) the suspension database and bring its schema
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
  }): Promise<SqliteSuspensionStore> {
    const driver = await resolveSqliteDriver(SQLITE_CONSUMER, options.loaders);
    const path =
      options.path === ":memory:"
        ? options.path
        : isAbsolute(options.path)
          ? options.path
          : resolve(process.cwd(), options.path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const db = new driver.Database(path);
    try {
      initialise(db);
    } catch (cause) {
      // The handle exists but no store owns it yet, so nothing else would
      // ever close it. Release it before the error propagates, otherwise a
      // context that falls back to memory leaves the file locked.
      try {
        db.close();
      } catch {
        // Already unusable; the original cause is what matters.
      }
      throw cause;
    }
    return new SqliteSuspensionStore(db, driver.name);
  }

  async create(record: NewSuspension): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO suspensions (
             id, route_id, position, continuation_hash, action_fingerprint,
             exchange, "schema", call_binding, meta,
             step_state, status, suspended_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.stepState === undefined
            ? null
            : JSON.stringify(encodePersistable(record.stepState, "stepState")),
          "suspended" satisfies SuspensionStatus,
          record.suspendedAt.getTime(),
          record.expiresAt ? record.expiresAt.getTime() : null,
        );
    } catch (cause) {
      // `encodePersistable` runs inside this try, so its RC5042 arrives here
      // too. Wrapping it as a store failure would replace "stepState holds a
      // function" with "failed to persist to the sqlite store", and the
      // memory backend, which encodes outside any catch, would report the
      // same input differently. Same passthrough `guard` uses below.
      if (isRoutecraftError(cause)) throw cause;
      // Discriminate the one failure the contract names. A duplicate id
      // means the id derivation is wrong, which no retry fixes, so it must
      // not reach a `.retry()` wrapper as a retryable error.
      const duplicate = /UNIQUE constraint failed/i.test(
        cause instanceof Error ? cause.message : String(cause),
      );
      if (busy(cause)) {
        throw rcError("RC5045", cause, {
          message: `The suspension store was busy while persisting "${record.id}".`,
        });
      }
      throw rcError("RC5044", cause, {
        message: duplicate
          ? `Suspension "${record.id}" already exists in the store.`
          : `Failed to persist suspension "${record.id}" to the sqlite store.`,
      });
    }
  }

  async get(id: string): Promise<Suspension | undefined> {
    return guard(`read suspension "${id}"`, () => {
      const row = this.#db
        .prepare(`SELECT * FROM suspensions WHERE id = ?`)
        .get(id);
      return row ? toSuspension(row as SuspensionRow) : undefined;
    });
  }

  async markResumed(
    id: string,
    resumption: SuspensionResumption,
  ): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions
          SET status = 'resumed', resumed_at = ?, settled_at = ?, resumed_by = ?
        WHERE id = ? AND status = 'suspended'`,
      [
        resumption.at.getTime(),
        resumption.at.getTime(),
        resumption.by ? JSON.stringify(resumption.by) : null,
      ],
    );
  }

  async claimExpiry(id: string, at: Date): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions SET status = 'expiring', claimed_at = ?
        WHERE id = ? AND status = 'suspended'`,
      [at.getTime()],
    );
  }

  async markExpired(id: string): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions SET status = 'expired', settled_at = ?
        WHERE id = ? AND status = 'expiring'`,
      [Date.now()],
    );
  }

  async markDenied(id: string, reason?: string): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions SET status = 'denied', denied_reason = ?, settled_at = ?
        WHERE id = ? AND status = 'expiring'`,
      [reason ?? null, Date.now()],
    );
  }

  async releaseExpiring(before: Date): Promise<number> {
    return guard("release stale expiry claims", () => {
      this.#db
        .prepare(
          `UPDATE suspensions SET status = 'suspended', claimed_at = NULL
            WHERE status = 'expiring' AND claimed_at <= ?`,
        )
        .run(before.getTime());
      return (
        this.#db.prepare("SELECT changes() AS changed").get() as {
          changed: number;
        }
      ).changed;
    });
  }

  async recordTerminal(id: string, terminal: SerializedOutcome): Promise<void> {
    guard(`record the terminal outcome of "${id}"`, () => {
      this.#db
        .prepare(`UPDATE suspensions SET terminal = ? WHERE id = ?`)
        .run(JSON.stringify(serializeTerminal(terminal)), id);
    });
  }

  async findExpired(
    now: Date,
    limit: number,
    after?: ExpiredScanCursor,
  ): Promise<Suspension[]> {
    assertSweepLimit(limit);
    assertScanCursor(after);
    return guard("scan for expired suspensions", () => {
      // The expanded `(a > x OR (a = x AND b > y))` form rather than
      // row-value syntax, which would put a floor on the SQLite version.
      const rows = after
        ? this.#db
            .prepare(
              `SELECT * FROM suspensions
                WHERE status = 'suspended'
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
              `SELECT * FROM suspensions
                WHERE status = 'suspended'
                  AND expires_at IS NOT NULL
                  AND expires_at <= ?
                ORDER BY expires_at ASC, id ASC
                LIMIT ?`,
            )
            .all(now.getTime(), limit);
      return rows.map((row) => toSuspension(row as SuspensionRow));
    });
  }

  async resumedWithoutTerminal(limit?: number): Promise<Suspension[]> {
    assertSweepLimit(limit);
    return guard("scan for stranded resumes", () => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM suspensions
          WHERE status = 'resumed'
            AND terminal IS NULL
          ORDER BY suspended_at ASC
          LIMIT ?`,
        )
        .all(limit ?? -1);
      return rows.map((row) => toSuspension(row as SuspensionRow));
    });
  }

  async pending(): Promise<PendingSuspensionSummary> {
    return guard("summarise pending suspensions", () => {
      const row = this.#db
        .prepare(
          `SELECT COUNT(*) AS count, MIN(suspended_at) AS oldest
           FROM suspensions WHERE status = 'suspended'`,
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
    return guard("purge settled suspensions", () => {
      this.#db
        .prepare(
          `DELETE FROM suspensions
          WHERE status IN ('resumed', 'expired', 'denied')
            AND settled_at < ?`,
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
   * Run a conditional `UPDATE` that only matches a still-suspended row, and
   * report whether this caller performed it.
   *
   * The update and the read-back run inside one immediate transaction so
   * the returned record is the state this transition produced, not a state
   * some later writer moved on to. The `WHERE status = 'suspended'` clause
   * is the compare half of the compare-and-swap; `changes` is the answer.
   */
  #transition(
    id: string,
    sql: string,
    leadingParams: unknown[],
  ): SuspensionCasResult {
    let won = false;
    let row: unknown;
    try {
      // BEGIN sits inside the try so a busy lock surfaces as the wrapped
      // store error this method promises, not as a raw driver throw.
      this.#db.exec("BEGIN IMMEDIATE");
      this.#db.prepare(sql).run(...leadingParams, id);
      // Read the affected-row count from SQLite rather than from the
      // driver's run() return value. `bun:sqlite` only began returning
      // `{ changes }` partway through the 1.1 line, and the declared floor
      // is 1.1.0, so trusting it would report every compare-and-swap as
      // lost on an in-range Bun: the row would transition, every caller
      // would be told it lost the race, and nothing would ever resume.
      won =
        (
          this.#db.prepare("SELECT changes() AS changed").get() as {
            changed: number;
          }
        ).changed === 1;
      row = this.#db.prepare(`SELECT * FROM suspensions WHERE id = ?`).get(id);
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // BEGIN itself failed, so there is no transaction to roll back.
        // The original cause is the one worth reporting.
      }
      throw rcError(busy(cause) ? "RC5045" : "RC5044", cause, {
        message: `Failed to transition suspension "${id}" in the sqlite store.`,
      });
    }
    // Decoding runs after COMMIT and outside the try: a corrupt column
    // would otherwise throw with no transaction active, and the rollback's
    // own "no transaction is active" error would replace the parse failure.
    return {
      won,
      suspension: row ? toSuspension(row as SuspensionRow) : undefined,
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
  // Set explicitly because the drivers disagree: better-sqlite3 defaults to
  // 5s, bun:sqlite to 0. Without this, a second writer on the same file (an
  // operator running the CLI against a live deployment, a restart
  // overlapping the previous shutdown) fails a resume instantly under Bun
  // and waits under Node, so the bug would not reproduce for whoever is
  // debugging on the other runtime.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
}

/**
 * Apply outstanding migrations inside a transaction, so an interrupted
 * upgrade leaves the file on its previous version rather than half-way
 * between two.
 *
 * @internal
 */
function migrate(db: SqliteDatabase): void {
  try {
    // The version is read INSIDE the write transaction. Two processes
    // starting against one file would otherwise both read version 0, both
    // try to create the tables, and the loser fail on an existing table.
    // For an unconfigured context that failure means falling back to the
    // non-durable memory store, which is the worst outcome a startup race
    // could have.
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    const current = row?.user_version ?? 0;
    // The downgrade guard has to run BEFORE the up-to-date check, not
    // after: a file written by a newer build satisfies both conditions, so
    // ordering it second made it unreachable and turned a rollback into a
    // misleading persist failure on the first suspend.
    if (current > SCHEMA_VERSION) {
      throw rcError("RC5044", undefined, {
        message: `Suspension store schema version ${current} is newer than this build understands (${SCHEMA_VERSION}). Run the newer Routecraft build, or point suspension.store.path at a fresh file.`,
      });
    }
    if (current === SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      db.exec(MIGRATIONS[version]!);
    }
    // Interpolated rather than bound: PRAGMA does not accept parameters.
    // The value is a module constant, never user input.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN itself failed; there is no transaction to roll back.
    }
    if (isRoutecraftError(cause)) throw cause;
    throw rcError("RC5044", cause, {
      message: "Failed to migrate the suspension store schema.",
    });
  }
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
    throw rcError(busy(cause) ? "RC5045" : "RC5044", cause, {
      message: `Failed to ${what} in the sqlite store.`,
    });
  }
}

/**
 * Whether a driver error is SQLite reporting lock contention rather than a
 * permanent fault. Both drivers surface it in the message; better-sqlite3
 * additionally sets a `code`.
 *
 * @internal
 */
function busy(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_BUSY|^SQLITE_LOCKED/.test(code)) {
    return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    message,
  );
}

/**
 * Row shape as the drivers return it. Both produce plain objects with
 * snake_case column names.
 *
 * @internal
 */
interface SuspensionRow {
  id: string;
  route_id: string;
  position: number;
  continuation_hash: string;
  action_fingerprint: string;
  exchange: string;
  schema: string;
  call_binding: string | null;
  meta: string | null;
  step_state: string | null;
  status: string;
  suspended_at: number;
  expires_at: number | null;
  claimed_at: number | null;
  settled_at: number | null;
  resumed_at: number | null;
  resumed_by: string | null;
  denied_reason: string | null;
  terminal: string | null;
}

/** @internal */
function toSuspension(row: SuspensionRow): Suspension {
  const terminal = row.terminal
    ? (JSON.parse(row.terminal) as SerializedOutcome & { at: string })
    : undefined;
  return {
    id: row.id,
    routeId: row.route_id,
    position: row.position,
    continuationHash: row.continuation_hash,
    actionFingerprint: row.action_fingerprint,
    exchange: JSON.parse(row.exchange) as SerializedExchange,
    schema: JSON.parse(row.schema) as SuspensionSchema,
    ...(row.call_binding !== null ? { callBinding: row.call_binding } : {}),
    ...(row.meta !== null ? { meta: JSON.parse(row.meta) as unknown } : {}),
    ...(row.step_state !== null
      ? { stepState: JSON.parse(row.step_state) as unknown }
      : {}),
    status: row.status as SuspensionStatus,
    suspendedAt: new Date(row.suspended_at),
    ...(row.expires_at !== null ? { expiresAt: new Date(row.expires_at) } : {}),
    ...(row.claimed_at != null ? { claimedAt: new Date(row.claimed_at) } : {}),
    ...(row.settled_at != null ? { settledAt: new Date(row.settled_at) } : {}),
    ...(row.resumed_at !== null ? { resumedAt: new Date(row.resumed_at) } : {}),
    ...(row.resumed_by !== null
      ? { resumedBy: JSON.parse(row.resumed_by) as PrincipalRef }
      : {}),
    ...(row.denied_reason !== null ? { deniedReason: row.denied_reason } : {}),
    ...(terminal
      ? { terminal: { ...terminal, at: new Date(terminal.at) } }
      : {}),
  };
}

/**
 * `Date` does not survive `JSON.stringify` as a `Date`, so the terminal
 * outcome's timestamp is written as an ISO string and revived in
 * {@link toSuspension}.
 *
 * @internal
 */
function serializeTerminal(terminal: SerializedOutcome): unknown {
  return {
    ...terminal,
    ...(terminal.body !== undefined
      ? { body: encodePersistable(terminal.body, "terminal.body") }
      : {}),
    at: terminal.at.toISOString(),
  };
}
