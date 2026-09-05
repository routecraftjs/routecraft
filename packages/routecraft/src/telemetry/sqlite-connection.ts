import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type SqliteDriverLoaders,
  resolveSqliteDriver,
} from "../shared/sqlite/driver.ts";
import type { SqliteDatabase } from "../shared/sqlite/types.ts";
import { resolveDatabasePath } from "../shared/sqlite/database.ts";
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
 * Names this subsystem in the absent-peer error, so a Node deployment
 * missing `better-sqlite3` reads which feature asked for it.
 */
const SQLITE_CONSUMER = "telemetry (sqlite)";

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
 * Backed by whichever synchronous driver the runtime provides:
 * `bun:sqlite` under Bun, `better-sqlite3` as an optional peer under Node.
 * When neither resolves, {@link open} returns `null` and the calling plugin
 * disables the SQLite path with a warn log, leaving an OTLP exporter
 * configured via `telemetry({ tracerProvider })` as the way to keep
 * telemetry flowing.
 */
export class SqliteConnection {
  readonly db: TelemetryDatabase;
  readonly logger: TelemetryLogger | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(db: TelemetryDatabase, logger?: TelemetryLogger) {
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
   * @param options - Database path and retention limits.
   * @param logger - Optional telemetry logger for the failure paths.
   * @param loaders - Driver loader injection point for tests.
   * @returns A connection, or `null` when no driver resolved or the
   *   database could not be opened.
   */
  static async open(
    options?: SqliteConnectionOptions,
    logger?: TelemetryLogger,
    loaders?: SqliteDriverLoaders,
  ): Promise<SqliteConnection | null> {
    const dbPathRaw = options?.dbPath ?? DEFAULT_DB_PATH;
    const dbPath = resolveDatabasePath(dbPathRaw);
    const walMode = options?.walMode !== false;

    let Database: TelemetryDatabaseConstructor;
    try {
      const driver = await resolveSqliteDriver(SQLITE_CONSUMER, loaders);
      Database = driver.Database as TelemetryDatabaseConstructor;
    } catch (err) {
      // Loud on both arms. Under Node the cause is a missing
      // `better-sqlite3` (RC5017 carries the install hint); under Bun a
      // throw means a broken install. Either way the user configured
      // `telemetry.sqlite` and is not getting it, which is not something to
      // swallow.
      logger?.warn(
        { err },
        "No SQLite driver available; the telemetry SQLite sink is disabled. Configure an OTLP exporter, or install the driver named in the error.",
      );
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

/**
 * The shared minimal surface plus the one member telemetry needs on top:
 * batched event inserts run inside a transaction. Both drivers expose it
 * with this shape.
 */
interface TelemetryDatabase extends SqliteDatabase {
  transaction<T>(fn: (...args: T[]) => void): (...args: T[]) => void;
}

type TelemetryDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean },
) => TelemetryDatabase;

export type { TelemetryDatabase };
