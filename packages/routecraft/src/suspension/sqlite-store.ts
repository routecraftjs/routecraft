import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { rcError } from "../error.ts";
import {
  type ResolvedSqliteDriver,
  type SqliteDatabase,
  type SqliteDriverLoaders,
  resolveSqliteDriver,
} from "./sqlite-driver.ts";
import type {
  PendingSuspensionSummary,
  PrincipalRef,
  SerializedExchange,
  SerializedOutcome,
  Suspension,
  SuspensionCasResult,
  SuspensionExpect,
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
 * Schema version this build writes. Bumped whenever
 * {@link MIGRATIONS} grows an entry.
 */
const SCHEMA_VERSION = 1;

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
];

/**
 * Durable suspension store on SQLite.
 *
 * One implementation over two drivers: `bun:sqlite` under Bun and
 * `better-sqlite3` under Node. Both are synchronous, which is what makes
 * the compare-and-swap methods genuinely atomic here: a single `UPDATE
 * ... WHERE status = 'suspended'` either changes one row or none, and the
 * driver returns which. See `sqlite-driver.ts` for the runtime-split
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
    const driver = await resolveSqliteDriver(options.loaders);
    const path =
      options.path === ":memory:"
        ? options.path
        : isAbsolute(options.path)
          ? options.path
          : resolve(process.cwd(), options.path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const db = new driver.Database(path);
    // WAL lets the sweeper read while a resume writes. Harmless on
    // `:memory:`, where SQLite ignores the journal mode change.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return new SqliteSuspensionStore(db, driver.name);
  }

  async create(record: Suspension): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO suspensions (
             id, route_id, position, continuation_hash, action_fingerprint,
             exchange, expect, step_state, status, suspended_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.routeId,
          record.position,
          record.continuationHash,
          record.actionFingerprint,
          JSON.stringify(record.exchange),
          JSON.stringify(record.expect),
          record.stepState === undefined
            ? null
            : JSON.stringify(record.stepState),
          record.status,
          record.suspendedAt.getTime(),
          record.expiresAt ? record.expiresAt.getTime() : null,
        );
    } catch (cause) {
      throw rcError("RC5001", cause, {
        message: `Failed to persist suspension "${record.id}" to the sqlite store.`,
      });
    }
  }

  async get(id: string): Promise<Suspension | undefined> {
    const row = this.#db
      .prepare(`SELECT * FROM suspensions WHERE id = ?`)
      .get(id);
    return row ? toSuspension(row as SuspensionRow) : undefined;
  }

  async markResumed(
    id: string,
    resumption: SuspensionResumption,
  ): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions
          SET status = 'resumed', resumed_at = ?, resumed_by = ?
        WHERE id = ? AND status = 'suspended'`,
      [
        resumption.at.getTime(),
        resumption.by ? JSON.stringify(resumption.by) : null,
      ],
    );
  }

  async markExpired(id: string): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions SET status = 'expired'
        WHERE id = ? AND status = 'suspended'`,
      [],
    );
  }

  async markDenied(id: string, reason?: string): Promise<SuspensionCasResult> {
    return this.#transition(
      id,
      `UPDATE suspensions SET status = 'denied', denied_reason = ?
        WHERE id = ? AND status = 'suspended'`,
      [reason ?? null],
    );
  }

  async recordTerminal(id: string, terminal: SerializedOutcome): Promise<void> {
    this.#db
      .prepare(`UPDATE suspensions SET terminal = ? WHERE id = ?`)
      .run(JSON.stringify(serializeTerminal(terminal)), id);
  }

  async findExpired(now: Date, limit?: number): Promise<Suspension[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM suspensions
          WHERE status = 'suspended'
            AND expires_at IS NOT NULL
            AND expires_at <= ?
          ORDER BY suspended_at ASC
          LIMIT ?`,
      )
      // A negative LIMIT means "no limit" in SQLite, which is exactly the
      // semantics of an omitted bound here.
      .all(now.getTime(), limit ?? -1);
    return rows.map((row) => toSuspension(row as SuspensionRow));
  }

  async pending(): Promise<PendingSuspensionSummary> {
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(sql).run(...leadingParams, id) as
        { changes?: number } | undefined;
      const row = this.#db
        .prepare(`SELECT * FROM suspensions WHERE id = ?`)
        .get(id);
      this.#db.exec("COMMIT");
      return {
        won: (result?.changes ?? 0) === 1,
        suspension: row ? toSuspension(row as SuspensionRow) : undefined,
      };
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw rcError("RC5001", cause, {
        message: `Failed to transition suspension "${id}" in the sqlite store.`,
      });
    }
  }
}

/**
 * Apply outstanding migrations inside a transaction, so an interrupted
 * upgrade leaves the file on its previous version rather than half-way
 * between two.
 *
 * @internal
 */
function migrate(db: SqliteDatabase): void {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  if (current > MIGRATIONS.length) {
    throw rcError("RC5003", undefined, {
      message: `Suspension store schema version ${current} is newer than this build understands (${SCHEMA_VERSION}). Run the newer Routecraft build, or point suspension.store.path at a fresh file.`,
    });
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (let version = current; version < SCHEMA_VERSION; version++) {
      db.exec(MIGRATIONS[version]!);
    }
    // Interpolated rather than bound: PRAGMA does not accept parameters.
    // The value is a module constant, never user input.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw rcError("RC5003", cause, {
      message: "Failed to migrate the suspension store schema.",
    });
  }
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
  expect: string;
  step_state: string | null;
  status: string;
  suspended_at: number;
  expires_at: number | null;
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
    expect: JSON.parse(row.expect) as SuspensionExpect,
    ...(row.step_state !== null
      ? { stepState: JSON.parse(row.step_state) as unknown }
      : {}),
    status: row.status as SuspensionStatus,
    suspendedAt: new Date(row.suspended_at),
    ...(row.expires_at !== null ? { expiresAt: new Date(row.expires_at) } : {}),
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
  return { ...terminal, at: terminal.at.toISOString() };
}
