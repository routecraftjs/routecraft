import type { TelemetryEvent, TelemetryExchange } from "@routecraft/routecraft";

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
 *
 * Use the static `open()` factory instead of the constructor directly.
 */
export class TelemetryDb {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * Open a telemetry database in read-only mode.
   *
   * Uses dynamic `import()` so the module resolves correctly under pnpm's
   * strict hoisting (CJS `require()` from an ESM bundle does not follow
   * the package's own dependency graph).
   */
  static async open(dbPath: string): Promise<TelemetryDb> {
    let Database: DatabaseConstructor;
    try {
      const mod = await import("better-sqlite3");
      Database = (
        "default" in mod && typeof mod.default === "function"
          ? mod.default
          : mod
      ) as DatabaseConstructor;
    } catch {
      throw new Error(
        "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3",
      );
    }

    const db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
    return new TelemetryDb(db);
  }

  /**
   * Get a summary of all routes with aggregated metrics.
   * Routes are grouped by ID across all context runs so that restarting
   * the same application does not create duplicate rows.
   */
  getRouteSummary(): Array<{
    id: string;
    status: string;
    totalExchanges: number;
    completedExchanges: number;
    failedExchanges: number;
    avgDurationMs: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        r.id,
        -- latest status across all context runs for this route
        (SELECT r2.status FROM routes r2
         WHERE r2.id = r.id
         ORDER BY r2.registered_at DESC LIMIT 1) AS status,
        COALESCE(COUNT(e.id), 0) AS totalExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0) AS completedExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedExchanges,
        AVG(e.duration_ms) AS avgDurationMs
      FROM routes r
      LEFT JOIN exchanges e ON r.id = e.route_id
      GROUP BY r.id
      ORDER BY MAX(r.registered_at) DESC
    `);
    return stmt.all() as Array<{
      id: string;
      status: string;
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      avgDurationMs: number | null;
    }>;
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
   * Get exchange counts bucketed by minute for the last N minutes.
   * Used to render a traffic sparkline in the dashboard.
   */
  getTrafficBuckets(minutes = 30): number[] {
    const stmt = this.db.prepare(`
      WITH RECURSIVE mins(m) AS (
        SELECT 0
        UNION ALL
        SELECT m + 1 FROM mins WHERE m < ? - 1
      )
      SELECT
        COALESCE(c.cnt, 0) AS cnt
      FROM mins
      LEFT JOIN (
        SELECT
          CAST((strftime('%s', 'now') - strftime('%s', started_at)) / 60 AS INTEGER) AS ago,
          COUNT(*) AS cnt
        FROM exchanges
        WHERE started_at >= datetime('now', '-' || ? || ' minutes')
        GROUP BY ago
      ) c ON c.ago = mins.m
      ORDER BY mins.m DESC
    `);
    return (stmt.all(minutes, minutes) as Array<{ cnt: number }>).map(
      (r) => r.cnt,
    );
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
