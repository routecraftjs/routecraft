import type {
  TelemetryEvent,
  TelemetryRoute,
  TelemetryExchange,
} from "@routecraft/routecraft";

/**
 * Minimal type for the better-sqlite3 database to avoid hard dependency.
 */
interface Database {
  prepare(sql: string): Statement;
  close(): void;
  pragma(pragma: string): unknown;
}

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

type DatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean },
) => Database;

/**
 * Read-only accessor for the telemetry SQLite database.
 * Used by the TUI to query historical data without affecting the running engine.
 */
export class TelemetryDb {
  private db: Database;

  constructor(dbPath: string) {
    // Dynamic import is handled by the caller; we receive the already-constructed db
    // But for simplicity, we construct it here with readonly mode
    const mod = TelemetryDb.loadDriver();
    this.db = new mod(dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
  }

  /**
   * Load the better-sqlite3 driver synchronously.
   * Throws if the package is not installed.
   */
  private static loadDriver(): DatabaseConstructor {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("better-sqlite3") as
        | DatabaseConstructor
        | { default: DatabaseConstructor };
      return (
        "default" in mod && typeof mod.default === "function"
          ? mod.default
          : mod
      ) as DatabaseConstructor;
    } catch {
      throw new Error(
        "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3",
      );
    }
  }

  /**
   * Get a summary of all routes with aggregated metrics.
   */
  getRouteSummary(): Array<
    TelemetryRoute & {
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      avgDurationMs: number | null;
    }
  > {
    const stmt = this.db.prepare(`
      SELECT
        r.id,
        r.context_id AS contextId,
        r.registered_at AS registeredAt,
        r.status,
        COALESCE(COUNT(e.id), 0) AS totalExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0) AS completedExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedExchanges,
        AVG(e.duration_ms) AS avgDurationMs
      FROM routes r
      LEFT JOIN exchanges e ON r.id = e.route_id AND r.context_id = e.context_id
      GROUP BY r.id, r.context_id
      ORDER BY r.registered_at DESC
    `);
    return stmt.all() as Array<
      TelemetryRoute & {
        totalExchanges: number;
        completedExchanges: number;
        failedExchanges: number;
        avgDurationMs: number | null;
      }
    >;
  }

  /**
   * Get exchanges for a specific route, ordered by most recent first.
   */
  getExchangesByRoute(routeId: string, limit = 50): TelemetryExchange[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        route_id AS routeId,
        context_id AS contextId,
        correlation_id AS correlationId,
        status,
        started_at AS startedAt,
        completed_at AS completedAt,
        duration_ms AS durationMs,
        error
      FROM exchanges
      WHERE route_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    return stmt.all(routeId, limit) as TelemetryExchange[];
  }

  /**
   * Get events for a specific exchange (by correlation/exchange ID).
   */
  getEventsByExchange(exchangeId: string): TelemetryEvent[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        timestamp,
        context_id AS contextId,
        event_name AS eventName,
        details
      FROM events
      WHERE event_name LIKE '%' || ? || '%'
         OR details LIKE '%' || ? || '%'
      ORDER BY id ASC
    `);
    return stmt.all(exchangeId, exchangeId) as TelemetryEvent[];
  }

  /**
   * Get recent events, optionally filtered by event name pattern or route ID.
   */
  getRecentEvents(options?: {
    limit?: number;
    eventNameFilter?: string;
    routeIdFilter?: string;
    sinceId?: number;
  }): TelemetryEvent[] {
    const limit = options?.limit ?? 100;
    const sinceId = options?.sinceId ?? 0;

    let sql = `
      SELECT
        id,
        timestamp,
        context_id AS contextId,
        event_name AS eventName,
        details
      FROM events
      WHERE id > ?
    `;
    const params: unknown[] = [sinceId];

    if (options?.eventNameFilter) {
      sql += " AND event_name LIKE ?";
      params.push(`%${options.eventNameFilter}%`);
    }

    if (options?.routeIdFilter) {
      sql += " AND (event_name LIKE ? OR details LIKE ?)";
      params.push(`%${options.routeIdFilter}%`, `%${options.routeIdFilter}%`);
    }

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as TelemetryEvent[];
  }

  /**
   * Get aggregated metrics for the dashboard.
   */
  getMetrics(): {
    totalRoutes: number;
    totalExchanges: number;
    completedExchanges: number;
    failedExchanges: number;
    errorRate: number;
    avgDurationMs: number | null;
  } {
    const stmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT id) FROM routes) AS totalRoutes,
        COUNT(*) AS totalExchanges,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedExchanges,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedExchanges,
        AVG(duration_ms) AS avgDurationMs
      FROM exchanges
    `);
    const row = stmt.get() as {
      totalRoutes: number;
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      avgDurationMs: number | null;
    };
    return {
      ...row,
      errorRate:
        row.totalExchanges > 0 ? row.failedExchanges / row.totalExchanges : 0,
    };
  }

  /**
   * Get the maximum event ID (for tailing/polling).
   */
  getMaxEventId(): number {
    const stmt = this.db.prepare(
      "SELECT COALESCE(MAX(id), 0) AS maxId FROM events",
    );
    const row = stmt.get() as { maxId: number };
    return row.maxId;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
