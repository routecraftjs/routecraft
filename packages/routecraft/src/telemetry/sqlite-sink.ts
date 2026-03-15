import { mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import type {
  TelemetrySink,
  TelemetryEvent,
  TelemetryRoute,
  TelemetryExchange,
  SqliteSinkOptions,
} from "./types.ts";
import { ALL_DDL } from "./schema.ts";

/**
 * Default path for the telemetry database, relative to cwd.
 */
const DEFAULT_DB_PATH = ".routecraft/telemetry.db";

/**
 * Built-in SQLite telemetry sink.
 *
 * Persists telemetry data to a local SQLite database using `better-sqlite3`.
 * WAL mode is enabled by default for concurrent read/write so the TUI viewer
 * can read the database while the engine writes.
 *
 * This is the default sink used by `telemetry()` when no custom sink is provided.
 */
export class SqliteTelemetrySink implements TelemetrySink {
  private db: BetterSqlite3Database | undefined;

  private insertEventStmt: BetterSqlite3Statement | undefined;
  private upsertRouteStmt: BetterSqlite3Statement | undefined;
  private updateRouteStatusStmt: BetterSqlite3Statement | undefined;
  private insertExchangeStmt: BetterSqlite3Statement | undefined;
  private updateExchangeCompletedStmt: BetterSqlite3Statement | undefined;
  private updateExchangeFailedStmt: BetterSqlite3Statement | undefined;
  private insertManyTxn: ((events: TelemetryEvent[]) => void) | undefined;

  /**
   * Open the database and create tables. Call once before writing.
   *
   * @returns `true` if the database was opened successfully, `false` if better-sqlite3 is not installed.
   */
  async open(options?: SqliteSinkOptions): Promise<boolean> {
    const dbPathRaw = options?.dbPath ?? DEFAULT_DB_PATH;
    const dbPath = isAbsolute(dbPathRaw)
      ? dbPathRaw
      : resolve(process.cwd(), dbPathRaw);
    const walMode = options?.walMode !== false;

    mkdirSync(dirname(dbPath), { recursive: true });

    let Database: BetterSqlite3Constructor;
    try {
      const mod = await import("better-sqlite3");
      Database = (mod.default ?? mod) as BetterSqlite3Constructor;
    } catch {
      return false;
    }

    this.db = new Database(dbPath);

    if (walMode) {
      this.db.pragma("journal_mode = WAL");
    }

    for (const ddl of ALL_DDL) {
      this.db.exec(ddl);
    }

    this.insertEventStmt = this.db.prepare(
      "INSERT INTO events (timestamp, context_id, event_name, details) VALUES (?, ?, ?, ?)",
    );

    this.upsertRouteStmt = this.db.prepare(
      `INSERT INTO routes (id, context_id, registered_at, status)
       VALUES (?, ?, ?, 'registered')
       ON CONFLICT(id, context_id) DO UPDATE SET status = 'registered'`,
    );

    this.updateRouteStatusStmt = this.db.prepare(
      "UPDATE routes SET status = ? WHERE id = ? AND context_id = ?",
    );

    this.insertExchangeStmt = this.db.prepare(
      `INSERT OR IGNORE INTO exchanges (id, route_id, context_id, correlation_id, status, started_at)
       VALUES (?, ?, ?, ?, 'started', ?)`,
    );

    this.updateExchangeCompletedStmt = this.db.prepare(
      `UPDATE exchanges SET status = 'completed', completed_at = ?, duration_ms = ?
       WHERE id = ? AND context_id = ?`,
    );

    this.updateExchangeFailedStmt = this.db.prepare(
      `UPDATE exchanges SET status = 'failed', completed_at = ?, duration_ms = ?, error = ?
       WHERE id = ? AND context_id = ?`,
    );

    this.insertManyTxn = this.db.transaction((events: TelemetryEvent[]) => {
      for (const event of events) {
        this.insertEventStmt!.run(
          event.timestamp,
          event.contextId,
          event.eventName,
          event.details,
        );
      }
    });

    return true;
  }

  writeEvents(events: TelemetryEvent[]): void {
    if (!this.insertManyTxn) return;
    try {
      this.insertManyTxn(events);
    } catch {
      // Non-blocking
    }
  }

  writeRoute(route: TelemetryRoute): void {
    if (!this.upsertRouteStmt) return;
    try {
      this.upsertRouteStmt.run(route.id, route.contextId, route.registeredAt);
    } catch {
      // Non-blocking
    }
  }

  updateRouteStatus(routeId: string, contextId: string, status: string): void {
    if (!this.updateRouteStatusStmt) return;
    try {
      this.updateRouteStatusStmt.run(status, routeId, contextId);
    } catch {
      // Non-blocking
    }
  }

  writeExchange(exchange: TelemetryExchange): void {
    if (!this.insertExchangeStmt) return;
    try {
      this.insertExchangeStmt.run(
        exchange.id,
        exchange.routeId,
        exchange.contextId,
        exchange.correlationId,
        exchange.startedAt,
      );
    } catch {
      // Non-blocking
    }
  }

  completeExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
  ): void {
    if (!this.updateExchangeCompletedStmt) return;
    try {
      this.updateExchangeCompletedStmt.run(
        completedAt,
        durationMs,
        exchangeId,
        contextId,
      );
    } catch {
      // Non-blocking
    }
  }

  failExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
    error: string,
  ): void {
    if (!this.updateExchangeFailedStmt) return;
    try {
      this.updateExchangeFailedStmt.run(
        completedAt,
        durationMs,
        error,
        exchangeId,
        contextId,
      );
    } catch {
      // Non-blocking
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }
}

// Minimal type definitions for better-sqlite3 to avoid requiring @types/better-sqlite3
// as a production dependency. The actual types are checked at runtime via dynamic import.

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
