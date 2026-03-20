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
 */
export class SqliteConnection {
  readonly db: BetterSqlite3Database;
  readonly logger: TelemetryLogger | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(db: BetterSqlite3Database, logger?: TelemetryLogger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Open (or create) the telemetry database.
   *
   * When `maxExchanges` or `maxEvents` are greater than 0, the connection
   * prunes on startup and schedules periodic pruning automatically.
   * The timer is stopped when {@link close} is called.
   *
   * @returns A connection, or `null` if `better-sqlite3` is not installed.
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

    let Database: BetterSqlite3Constructor;
    try {
      const mod = await import("better-sqlite3");
      Database = (mod.default ?? mod) as BetterSqlite3Constructor;
    } catch {
      return null;
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });

      const db = new Database(dbPath);

      if (walMode) {
        db.pragma("journal_mode = WAL");
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

// Minimal type definitions for better-sqlite3 to avoid requiring
// @types/better-sqlite3 as a production dependency.

type BetterSqlite3Database = {
  pragma(pragma: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3Statement;
  transaction<T>(fn: (...args: T[]) => void): (...args: T[]) => void;
  close(): void;
};

type BetterSqlite3Statement = {
  run(...params: unknown[]): unknown;
};

type BetterSqlite3Constructor = new (filename: string) => BetterSqlite3Database;

export type { BetterSqlite3Database, BetterSqlite3Statement };
