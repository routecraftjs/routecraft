import type { TelemetryEvent } from "@routecraft/routecraft";

/** Exchange row shape from the telemetry SQLite database. */
interface TelemetryExchange {
  id: string;
  routeId: string;
  contextId: string;
  correlationId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

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
  run(...params: unknown[]): unknown;
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
/** Escape LIKE metacharacters so they match literally. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export class TelemetryDb {
  private db: Database;
  private stmtCache = new Map<string, Statement>();

  private constructor(db: Database) {
    this.db = db;
  }

  /** Prepare and cache a statement by key. Avoids re-parsing on every call. */
  private stmt(key: string, sql: string): Statement {
    let s = this.stmtCache.get(key);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(key, s);
    }
    return s;
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

    // Ensure indexes exist for TUI query performance.
    // If the DB was created before indexes were added, create them now
    // using a separate writable connection.
    {
      const wdb = new Database(dbPath);
      try {
        wdb
          .prepare(
            "CREATE INDEX IF NOT EXISTS idx_exchanges_started_at ON exchanges(started_at)",
          )
          .run();
        wdb
          .prepare(
            "CREATE INDEX IF NOT EXISTS idx_exchanges_route_started ON exchanges(route_id, started_at)",
          )
          .run();
        wdb
          .prepare(
            "CREATE INDEX IF NOT EXISTS idx_exchanges_correlation_id ON exchanges(correlation_id)",
          )
          .run();
        // Add exchange_id/correlation_id columns to events table if missing
        const cols = wdb.prepare("PRAGMA table_info(events)").all() as Array<{
          name: string;
        }>;
        if (!cols.some((c) => c.name === "exchange_id")) {
          wdb.prepare("ALTER TABLE events ADD COLUMN exchange_id TEXT").run();
          wdb
            .prepare("ALTER TABLE events ADD COLUMN correlation_id TEXT")
            .run();
        }
        wdb
          .prepare(
            "CREATE INDEX IF NOT EXISTS idx_events_exchange_id ON events(exchange_id)",
          )
          .run();
        wdb
          .prepare(
            "CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON events(correlation_id)",
          )
          .run();
        // Ensure exchange_snapshots table exists for older databases
        wdb
          .prepare(
            `CREATE TABLE IF NOT EXISTS exchange_snapshots (
              exchange_id TEXT NOT NULL,
              context_id TEXT NOT NULL,
              headers TEXT NOT NULL,
              body TEXT,
              truncated INTEGER NOT NULL DEFAULT 0,
              captured_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (exchange_id, context_id)
            )`,
          )
          .run();
      } catch {
        // Best-effort; the writer will create them on next restart
      } finally {
        wdb.close();
      }
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
    const s = this.stmt(
      "routeSummary",
      `WITH unique_routes AS (
        SELECT
          id,
          MAX(registered_at) AS registered_at,
          (SELECT r2.status FROM routes r2
           WHERE r2.id = r.id
           ORDER BY r2.registered_at DESC LIMIT 1) AS status
        FROM routes r
        GROUP BY id
      ),
      exchange_counts AS (
        SELECT
          route_id,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) AS dropped
        FROM exchanges
        GROUP BY route_id
      ),
      recent_avg AS (
        SELECT route_id, AVG(duration_ms) AS avgDur
        FROM exchanges
        WHERE started_at >= datetime('now', '-5 minutes')
        GROUP BY route_id
      )
      SELECT
        ur.id,
        ur.status,
        COALESCE(ec.total, 0) AS totalExchanges,
        COALESCE(ec.completed, 0) AS completedExchanges,
        COALESCE(ec.failed, 0) AS failedExchanges,
        COALESCE(ec.dropped, 0) AS droppedExchanges,
        ra.avgDur AS avgDurationMs
      FROM unique_routes ur
      LEFT JOIN exchange_counts ec ON ur.id = ec.route_id
      LEFT JOIN recent_avg ra ON ur.id = ra.route_id
      ORDER BY ur.registered_at DESC`,
    );
    return s.all() as Array<{
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
  getExchangesByRoute(routeId: string, limit = -1): TelemetryExchange[] {
    const s = this.stmt(
      "exchangesByRoute",
      `SELECT
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
      LIMIT ?`,
    );
    return s.all(routeId, limit) as TelemetryExchange[];
  }

  /**
   * Get all exchanges across all routes, ordered by most recent first.
   */
  getAllExchanges(limit = -1): TelemetryExchange[] {
    const s = this.stmt(
      "allExchanges",
      `SELECT
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
      ORDER BY started_at DESC
      LIMIT ?`,
    );
    return s.all(limit) as TelemetryExchange[];
  }

  /**
   * Get all failed exchanges across all routes, ordered by most recent first.
   * Shows every failed exchange including child exchanges from split/multicast,
   * without deduplication by correlation chain.
   */
  getFailedExchanges(limit = -1): TelemetryExchange[] {
    const s = this.stmt(
      "failedExchanges",
      `SELECT
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
      WHERE status = 'failed'
      ORDER BY started_at DESC
      LIMIT ?`,
    );
    return s.all(limit) as TelemetryExchange[];
  }

  /**
   * Get events for an exchange and all related exchanges sharing the
   * same correlation ID. Uses indexed exchange_id/correlation_id columns
   * with a fallback to details LIKE for databases created before the
   * column migration.
   */
  getEventsByExchange(
    exchangeId: string,
    correlationId: string,
  ): TelemetryEvent[] {
    const searchId = correlationId || exchangeId;

    // Try indexed column lookup first (fast path)
    const hasColumns = this.hasEventIdColumns();
    if (hasColumns) {
      const s = this.stmt(
        "eventsByExchangeIndexed",
        `SELECT
          id,
          timestamp,
          context_id AS contextId,
          event_name AS eventName,
          details
        FROM events
        WHERE exchange_id = ? OR correlation_id = ?
        ORDER BY id ASC`,
      );
      return s.all(searchId, searchId) as TelemetryEvent[];
    }

    // Fallback: full-text LIKE scan for older databases
    const s = this.stmt(
      "eventsByExchangeFallback",
      `SELECT
        id,
        timestamp,
        context_id AS contextId,
        event_name AS eventName,
        details
      FROM events
      WHERE details LIKE '%' || ? || '%' ESCAPE '\\'
      ORDER BY id ASC`,
    );
    return s.all(escapeLike(searchId)) as TelemetryEvent[];
  }

  /** Check whether the events table has the exchange_id column. */
  private hasEventIdColumns(): boolean {
    if (this._hasEventIdColumns !== undefined) return this._hasEventIdColumns;
    try {
      const info = this.db.prepare("PRAGMA table_info(events)").all() as Array<{
        name: string;
      }>;
      this._hasEventIdColumns = info.some((col) => col.name === "exchange_id");
    } catch {
      this._hasEventIdColumns = false;
    }
    return this._hasEventIdColumns;
  }
  private _hasEventIdColumns: boolean | undefined;

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
      sql += " AND event_name LIKE ? ESCAPE '\\'";
      params.push(`%${escapeLike(options.eventNameFilter)}%`);
    }

    if (options?.routeIdFilter) {
      sql +=
        " AND (event_name LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')";
      const escaped = escapeLike(options.routeIdFilter);
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as TelemetryEvent[];
  }

  /**
   * Get aggregated metrics for the dashboard, including duration percentiles.
   * Percentiles are computed over exchanges from the last 5 minutes.
   */
  getMetrics(): import("./types.js").Metrics {
    const s = this.stmt(
      "metrics",
      `SELECT
        (SELECT COUNT(DISTINCT id) FROM routes) AS totalRoutes,
        (SELECT COUNT(*) FROM exchanges) AS totalExchanges,
        (SELECT COUNT(*) FROM exchanges WHERE status = 'completed') AS completedExchanges,
        (SELECT COUNT(*) FROM exchanges WHERE status = 'failed') AS failedExchanges,
        (SELECT COUNT(*) FROM exchanges WHERE status = 'dropped') AS droppedExchanges,
        (SELECT AVG(duration_ms) FROM exchanges
         WHERE started_at >= datetime('now', '-5 minutes')) AS avgDurationMs`,
    );
    const row = s.get() as {
      totalRoutes: number;
      totalExchanges: number;
      completedExchanges: number;
      failedExchanges: number;
      droppedExchanges: number;
      avgDurationMs: number | null;
    };

    // Compute percentiles from recent exchanges with non-null durations
    const pctStmt = this.stmt(
      "percentiles",
      `SELECT duration_ms
       FROM exchanges
       WHERE duration_ms IS NOT NULL
         AND started_at >= datetime('now', '-5 minutes')
       ORDER BY duration_ms ASC`,
    );
    const durations = (pctStmt.all() as Array<{ duration_ms: number }>).map(
      (r) => r.duration_ms,
    );

    return {
      ...row,
      errorRate:
        row.totalExchanges > 0 ? row.failedExchanges / row.totalExchanges : 0,
      p90DurationMs: percentile(durations, 0.9),
      p95DurationMs: percentile(durations, 0.95),
      p99DurationMs: percentile(durations, 0.99),
    };
  }

  /**
   * Get exchange counts for a rolling window using fine-grained buckets.
   * Default: 60 buckets of 5 seconds = 5-minute rolling window.
   * Returns values oldest-first for sparkline rendering.
   */
  getLiveTrafficBuckets(bucketCount = 60, bucketWidthSec = 5): number[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const snapped = Math.floor(nowSec / bucketWidthSec) * bucketWidthSec;
    const windowStart = snapped - bucketCount * bucketWidthSec;

    const s = this.stmt(
      "liveTraffic",
      `SELECT
        CAST((CAST(strftime('%s', started_at) AS INTEGER) - ?) / ? AS INTEGER) AS bucket,
        COUNT(*) AS cnt
      FROM exchanges
      WHERE CAST(strftime('%s', started_at) AS INTEGER) >= ?
        AND CAST(strftime('%s', started_at) AS INTEGER) <= ?
      GROUP BY bucket`,
    );
    const rows = s.all(
      windowStart,
      bucketWidthSec,
      windowStart,
      snapped,
    ) as Array<{ bucket: number; cnt: number }>;

    const result = new Array(bucketCount).fill(0) as number[];
    for (const row of rows) {
      if (row.bucket >= 0 && row.bucket < bucketCount) {
        result[row.bucket] += row.cnt;
      }
    }
    return result;
  }

  /**
   * Get activity data for a single route: throughput sparkline + recent error count.
   */
  getSingleRouteActivity(
    routeId: string,
    bucketCount = 12,
    bucketWidthSec = 5,
  ): { throughput: number[]; recentErrors: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const snapped = Math.floor(nowSec / bucketWidthSec) * bucketWidthSec;
    const windowStart = snapped - bucketCount * bucketWidthSec;

    const tStmt = this.stmt(
      "singleRouteActivity",
      `SELECT
        CAST((CAST(strftime('%s', started_at) AS INTEGER) - ?) / ? AS INTEGER) AS bucket,
        COUNT(*) AS cnt
      FROM exchanges
      WHERE route_id = ?
        AND CAST(strftime('%s', started_at) AS INTEGER) >= ?
      GROUP BY bucket`,
    );
    const tRows = tStmt.all(
      windowStart,
      bucketWidthSec,
      routeId,
      windowStart,
    ) as Array<{ bucket: number; cnt: number }>;

    const eStmt = this.stmt(
      "singleRouteErrors",
      `SELECT COUNT(*) AS cnt
      FROM exchanges
      WHERE route_id = ?
        AND status = 'failed'
        AND CAST(strftime('%s', started_at) AS INTEGER) >= ?`,
    );
    const eRow = eStmt.get(routeId, windowStart) as { cnt: number } | undefined;

    const throughput = new Array(bucketCount).fill(0) as number[];
    for (const row of tRows) {
      if (row.bucket >= 0 && row.bucket < bucketCount) {
        throughput[row.bucket] = row.cnt;
      }
    }

    return { throughput, recentErrors: eRow?.cnt ?? 0 };
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
   * Get the exchange snapshot (headers and body) for a given exchange.
   * Returns null if no snapshot was captured.
   */
  getExchangeSnapshot(
    exchangeId: string,
  ): import("./types.js").ExchangeSnapshot | null {
    try {
      const s = this.stmt(
        "exchangeSnapshot",
        `SELECT headers, body, truncated
         FROM exchange_snapshots
         WHERE exchange_id = ?
         LIMIT 1`,
      );
      const row = s.get(exchangeId) as
        | { headers: string; body: string | null; truncated: number }
        | undefined;
      if (!row) return null;
      return {
        headers: row.headers,
        body: row.body,
        truncated: row.truncated !== 0,
      };
    } catch {
      // Table may not exist in very old databases
      return null;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Compute a percentile from a sorted array of numbers using linear interpolation.
 * Returns null if the array is empty.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
