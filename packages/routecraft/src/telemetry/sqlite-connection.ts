/// <reference types="bun-types" />
import { mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { ALL_DDL } from "./schema.ts";
import type { TelemetryLogger } from "./types.ts";

/**
 * Default path for the telemetry database, relative to cwd.
 */
const DEFAULT_DB_PATH = ".routecraft/telemetry.db";

/**
 * Options accepted by {@link SqliteConnection.open}.
 */
export interface SqliteConnectionOptions {
  /** Path to the SQLite database file. */
  dbPath?: string;
  /** Enable WAL mode (defaults to `true`). */
  walMode?: boolean;
  /**
   * Maximum number of exchange rows to retain.
   * Older rows are pruned on startup and periodically.
   * Set to `0` to disable exchange pruning. Defaults to `0` (disabled).
   */
  maxExchanges?: number;
  /**
   * Maximum number of event rows to retain.
   * Older rows are pruned on startup and periodically.
   * Set to `0` to disable event pruning. Defaults to `0` (disabled).
   */
  maxEvents?: number;
}

/**
 * Default prune interval in milliseconds (60 seconds).
 */
const PRUNE_INTERVAL_MS = 60_000;

/**
 * Shared SQLite connection for telemetry.
 *
 * Encapsulates database opening, WAL mode, DDL execution, and data
 * retention pruning. Pruning is a storage-layer concern and is managed
 * entirely within this class.
 *
 * Used by both {@link SqliteSpanProcessor} and {@link SqliteEventWriter}.
 *
 * Backed by `bun:sqlite`, so the SQLite sink only works under Bun. Under
 * Node, {@link open} returns `null` and the calling plugin disables the
 * SQLite path with a warn log. Node embedders should configure an OTLP
 * exporter via `telemetry({ tracerProvider })` instead.
 */
export class SqliteConnection {
  readonly db: BunSqliteDatabase;
  readonly logger: TelemetryLogger | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(db: BunSqliteDatabase, logger?: TelemetryLogger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Loader for the `bun:sqlite` driver. Exposed as a static so tests can
   * substitute an alternate implementation (e.g. better-sqlite3 under
   * vitest's Node pool, before the full bun:test migration).
   * @internal
   */
  static loadDriver: () => Promise<BunSqliteDatabaseConstructor> = async () => {
    const mod = await import("bun:sqlite");
    return mod.Database as unknown as BunSqliteDatabaseConstructor;
  };

  /**
   * Open (or create) the telemetry database.
   *
   * When `maxExchanges` or `maxEvents` are greater than 0, the connection
   * prunes on startup and schedules periodic pruning automatically.
   * The timer is stopped when {@link close} is called.
   *
   * @returns A connection, or `null` if the runtime is not Bun.
   */
  static async open(
    options?: SqliteConnectionOptions,
    logger?: TelemetryLogger,
  ): Promise<SqliteConnection | null> {
    const dbPathRaw = options?.dbPath ?? DEFAULT_DB_PATH;
    const dbPath = isAbsolute(dbPathRaw)
      ? dbPathRaw
      : resolve(process.cwd(), dbPathRaw);
    const walMode = options?.walMode !== false;

    let Database: BunSqliteDatabaseConstructor;
    try {
      Database = await SqliteConnection.loadDriver();
    } catch (err) {
      // Under Node, `bun:sqlite` resolves to ERR_MODULE_NOT_FOUND -- expected,
      // disable silently. Under Bun, a throw from the dynamic import indicates
      // a real bug (broken Bun install, removed module, etc.) and we must NOT
      // silently swallow it; surface via the logger.
      if (typeof process.versions["bun"] === "string") {
        logger?.warn({ err }, "Failed to load bun:sqlite driver");
      }
      return null;
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });

      const db = new Database(dbPath);

      if (walMode) {
        db.exec("PRAGMA journal_mode = WAL");
      }

      for (const ddl of ALL_DDL) {
        db.exec(ddl);
      }

      const conn = new SqliteConnection(db, logger);
      conn.startPruning(options?.maxExchanges ?? 0, options?.maxEvents ?? 0);
      return conn;
    } catch (err) {
      logger?.warn({ err }, "Failed to open telemetry SQLite database");
      return null;
    }
  }

  /**
   * Run an initial prune and schedule periodic pruning if limits are set.
   */
  private startPruning(maxExchanges: number, maxEvents: number): void {
    if (maxExchanges <= 0 && maxEvents <= 0) return;

    this.prune(maxExchanges, maxEvents);
    this.pruneTimer = setInterval(
      () => this.prune(maxExchanges, maxEvents),
      PRUNE_INTERVAL_MS,
    );
    this.pruneTimer.unref();
  }

  /**
   * Delete old rows beyond the configured retention limits.
   * Uses ROWID ordering for efficient deletion without scanning timestamps.
   */
  private prune(maxExchanges: number, maxEvents: number): void {
    try {
      if (maxExchanges > 0) {
        this.db
          .prepare(
            `DELETE FROM exchanges WHERE ROWID <= (
              SELECT ROWID FROM exchanges ORDER BY ROWID DESC LIMIT 1 OFFSET ?
            )`,
          )
          .run(maxExchanges);

        // Remove orphaned snapshots whose exchange was pruned
        this.db.exec(
          `DELETE FROM exchange_snapshots
           WHERE exchange_id NOT IN (SELECT id FROM exchanges)`,
        );
      }
      if (maxEvents > 0) {
        this.db
          .prepare(
            `DELETE FROM events WHERE id <= (
              SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?
            )`,
          )
          .run(maxEvents);
      }
    } catch {
      // Pruning is best-effort; do not disrupt the running application
    }
  }

  close(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    try {
      this.db.close();
    } catch {
      // Ignore close errors during teardown
    }
  }
}

// Minimal type definitions for `bun:sqlite` to avoid pulling `bun-types`
// into the public type surface. These mirror the subset of the API used
// by `SqliteConnection` and downstream telemetry consumers.

type BunSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): BunSqliteStatement;
  query(sql: string): BunSqliteStatement;
  transaction<T>(fn: (...args: T[]) => void): (...args: T[]) => void;
  close(): void;
};

type BunSqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type BunSqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean },
) => BunSqliteDatabase;

export type { BunSqliteDatabase, BunSqliteStatement };
