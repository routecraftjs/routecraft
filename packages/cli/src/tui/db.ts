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
    try {
      db.pragma("journal_mode = WAL");
    } catch {
      // Read-only connection cannot change journal mode; safe to ignore
    }
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
    droppedExchanges: number;
    avgDurationMs: number | null;
  }> {
    const stmt = this.db.prepare(`
      WITH unique_routes AS (
        SELECT
          id,
          MAX(registered_at) AS registered_at,
          -- latest status across all context runs
          (SELECT r2.status FROM routes r2
           WHERE r2.id = r.id
           ORDER BY r2.registered_at DESC LIMIT 1) AS status
        FROM routes r
        GROUP BY id
      )
      SELECT
        ur.id,
        ur.status,
        COALESCE(COUNT(e.id), 0) AS totalExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0) AS completedExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedExchanges,
        COALESCE(SUM(CASE WHEN e.status = 'dropped' THEN 1 ELSE 0 END), 0) AS droppedExchanges,
        AVG(e.duration_ms) AS avgDurationMs
      FROM unique_routes ur
      LEFT JOIN exchanges e ON ur.id = e.route_id
      GROUP BY ur.id
      ORDER BY ur.registered_at DESC
    `);
    return stmt.all() as Array<{
      id: string;
      status: string;
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      droppedExchanges: number;
      avgDurationMs: number | null;
    }>;
  }

  /**
   * Get exchanges for a specific route, ordered by most recent first.
   */
  getExchangesByRoute(routeId: string, limit = 50): TelemetryExchange[] {
    const stmt = this.db.prepare(`
      SELECT
        e.id,
        e.route_id AS routeId,
        e.context_id AS contextId,
        e.correlation_id AS correlationId,
        e.status,
        e.started_at AS startedAt,
        e.completed_at AS completedAt,
        e.duration_ms AS durationMs,
        e.error
      FROM exchanges e
      INNER JOIN (
        SELECT correlation_id, MIN(ROWID) AS first_rowid
        FROM exchanges
        GROUP BY correlation_id
      ) p ON e.correlation_id = p.correlation_id AND e.ROWID = p.first_rowid
      WHERE e.route_id = ?
      ORDER BY e.started_at DESC
      LIMIT ?
    `);
    return stmt.all(routeId, limit) as TelemetryExchange[];
  }

  /**
   * Get all exchanges across all routes, ordered by most recent first.
   */
  getAllExchanges(limit = 200): TelemetryExchange[] {
    const stmt = this.db.prepare(`
      SELECT
        e.id,
        e.route_id AS routeId,
        e.context_id AS contextId,
        e.correlation_id AS correlationId,
        e.status,
        e.started_at AS startedAt,
        e.completed_at AS completedAt,
        e.duration_ms AS durationMs,
        e.error
      FROM exchanges e
      INNER JOIN (
        SELECT correlation_id, MIN(ROWID) AS first_rowid
        FROM exchanges
        GROUP BY correlation_id
      ) p ON e.correlation_id = p.correlation_id AND e.ROWID = p.first_rowid
      ORDER BY e.started_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as TelemetryExchange[];
  }

  /**
   * Get all failed exchanges across all routes, ordered by most recent first.
   */
  getFailedExchanges(limit = 200): TelemetryExchange[] {
    const stmt = this.db.prepare(`
      SELECT
        e.id,
        e.route_id AS routeId,
        e.context_id AS contextId,
        e.correlation_id AS correlationId,
        e.status,
        e.started_at AS startedAt,
        e.completed_at AS completedAt,
        e.duration_ms AS durationMs,
        e.error
      FROM exchanges e
      INNER JOIN (
        SELECT correlation_id, MIN(ROWID) AS first_rowid
        FROM exchanges
        GROUP BY correlation_id
      ) p ON e.correlation_id = p.correlation_id AND e.ROWID = p.first_rowid
      WHERE e.status = 'failed'
      ORDER BY e.started_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as TelemetryExchange[];
  }

  /**
   * Get events for an exchange and all related exchanges sharing the
   * same correlation ID. Searches the details JSON for the correlation ID.
   */
  getEventsByExchange(
    exchangeId: string,
    correlationId: string,
  ): TelemetryEvent[] {
    const searchId = correlationId || exchangeId;
    const stmt = this.db.prepare(`
      SELECT
        id,
        timestamp,
        context_id AS contextId,
        event_name AS eventName,
        details
      FROM events
      WHERE details LIKE '%' || ? || '%'
      ORDER BY id ASC
    `);
    return stmt.all(searchId) as TelemetryEvent[];
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
    droppedExchanges: number;
    errorRate: number;
    avgDurationMs: number | null;
  } {
    const stmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT id) FROM routes) AS totalRoutes,
        COUNT(*) AS totalExchanges,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completedExchanges,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failedExchanges,
        COALESCE(SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END), 0) AS droppedExchanges,
        AVG(duration_ms) AS avgDurationMs
      FROM exchanges
    `);
    const row = stmt.get() as {
      totalRoutes: number;
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      droppedExchanges: number;
      avgDurationMs: number | null;
    };
    return {
      ...row,
      errorRate:
        row.totalExchanges > 0 ? row.failedExchanges / row.totalExchanges : 0,
    };
  }

  /**
   * Get exchange counts for the last hour in fixed 5-minute buckets.
   * Returns 12 values (oldest first, newest last), sliding left as time passes.
   */
  getTrafficBuckets(): number[] {
    const buckets = 12;
    const bucketWidthSec = 300; // 5 minutes

    // Snap "now" to a 5-minute boundary so buckets don't shift between polls
    const nowSec = Math.floor(Date.now() / 1000);
    const snappedNowSec = Math.floor(nowSec / bucketWidthSec) * bucketWidthSec;
    const windowStartSec = snappedNowSec - buckets * bucketWidthSec;

    const stmt = this.db.prepare(`
      SELECT
        CAST((CAST(strftime('%s', started_at) AS INTEGER) - ?) / ? AS INTEGER) AS bucket,
        COUNT(*) AS cnt
      FROM exchanges
      WHERE CAST(strftime('%s', started_at) AS INTEGER) >= ?
        AND CAST(strftime('%s', started_at) AS INTEGER) <= ?
      GROUP BY bucket
    `);
    const rows = stmt.all(
      windowStartSec,
      bucketWidthSec,
      windowStartSec,
      snappedNowSec,
    ) as Array<{ bucket: number; cnt: number }>;

    const result = new Array(buckets).fill(0) as number[];
    for (const row of rows) {
      if (row.bucket >= 0 && row.bucket < buckets) {
        result[row.bucket] += row.cnt;
      }
    }
    return result;
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
