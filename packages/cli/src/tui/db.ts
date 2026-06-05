/// <reference types="bun-types" />
import type { TelemetryEvent } from "@routecraft/routecraft";
import type {
  AgentSummary,
  ToolSummary,
  AgentRunInfo,
  ToolCallRow,
} from "./types.js";

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

/** Raw event row used by the agent/tool derivation queries. */
interface EventRow {
  id: number;
  timestamp: string;
  eventName: string;
  details: string;
  exchangeId: string | null;
}

/** Parse an event `details` JSON string, returning {} on failure. */
function parseDetails(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read the sensitive `_snapshot` envelope from a tool event's details. */
function snapshotField(
  d: Record<string, unknown>,
  field: "input" | "output",
): { present: boolean; json: string | null } {
  const snap = d["_snapshot"];
  if (snap && typeof snap === "object" && field in (snap as object)) {
    const val = (snap as Record<string, unknown>)[field];
    return { present: true, json: JSON.stringify(val ?? null) };
  }
  return { present: false, json: null };
}

/**
 * Correlate a time-ordered list of `agent:tool:*` events into one row per
 * `toolCallId`, merging the invoked event with its later result/error.
 */
function correlateToolCalls(rows: EventRow[]): ToolCallRow[] {
  const byCall = new Map<string, ToolCallRow>();
  const order: string[] = [];
  for (const row of rows) {
    const d = parseDetails(row.details);
    const suffix = row.eventName.split(":").pop();
    const toolCallId = asString(d["toolCallId"]) ?? `${row.id}`;
    let call = byCall.get(toolCallId);
    if (!call) {
      call = {
        toolCallId,
        toolName: asString(d["toolName"]) ?? "?",
        routeId: asString(d["routeId"]) ?? "",
        exchangeId: row.exchangeId ?? asString(d["exchangeId"]) ?? "",
        agentName: asString(d["agentName"]) ?? null,
        status: "invoked",
        durationMs: null,
        timestamp: row.timestamp,
        hasInput: false,
        hasOutput: false,
        input: null,
        output: null,
        error: null,
      };
      byCall.set(toolCallId, call);
      order.push(toolCallId);
    }
    const toolName = asString(d["toolName"]);
    if (toolName) call.toolName = toolName;
    if (suffix === "invoked") {
      const snap = snapshotField(d, "input");
      call.hasInput = snap.present;
      call.input = snap.json;
    } else if (suffix === "result") {
      call.status = "result";
      call.durationMs = asNumber(d["duration"]) ?? call.durationMs;
      const snap = snapshotField(d, "output");
      call.hasOutput = snap.present;
      call.output = snap.json;
    } else if (suffix === "error") {
      call.status = "error";
      call.durationMs = asNumber(d["duration"]) ?? call.durationMs;
      call.error = JSON.stringify(d["error"] ?? null);
    }
  }
  return order.map((id) => byCall.get(id)!);
}

/**
 * Minimal type for the bun:sqlite database to avoid pulling bun-types
 * into the CLI's public type surface.
 */
interface Database {
  prepare(sql: string): Statement;
  query(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

type DatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean },
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
   * Uses dynamic `import("bun:sqlite")` so the module resolves at runtime
   * (the CLI is Bun-only; `bun:sqlite` is a Bun built-in and is not a
   * resolvable spec under Node).
   */
  static async open(dbPath: string): Promise<TelemetryDb> {
    let Database: DatabaseConstructor;
    try {
      const mod = await import("bun:sqlite");
      Database = mod.Database as unknown as DatabaseConstructor;
    } catch {
      throw new Error(
        "bun:sqlite is not available. The craft CLI requires Bun >= 1.1.0.",
      );
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec("PRAGMA journal_mode = WAL");
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
    const windowStart = snapped - (bucketCount - 1) * bucketWidthSec;

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
      snapped + bucketWidthSec,
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
    const windowStart = snapped - (bucketCount - 1) * bucketWidthSec;

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

  // -- Agents tab --

  /**
   * List agents derived from registration (`agent:registered`) and
   * lifecycle (`route:*:agent:started|finished|error`) events. By-name
   * agents are keyed by their registered id; inline agents by their
   * dispatching route id.
   */
  getAgents(): AgentSummary[] {
    const rows = this.stmt(
      "agentLifecycle",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE event_name = 'agent:registered'
          OR event_name LIKE 'route:%:agent:started'
          OR event_name LIKE 'route:%:agent:finished'
          OR event_name LIKE 'route:%:agent:error'
       ORDER BY id ASC`,
    ).all() as EventRow[];

    interface Acc {
      key: string;
      source: "registered" | "inline";
      model: string | null;
      description: string | null;
      runs: Set<string>;
      errorCount: number;
      totalTokens: number;
      lastRunAt: string | null;
    }
    const map = new Map<string, Acc>();
    const ensure = (key: string, source: "registered" | "inline"): Acc => {
      let acc = map.get(key);
      if (!acc) {
        acc = {
          key,
          source,
          model: null,
          description: null,
          runs: new Set(),
          errorCount: 0,
          totalTokens: 0,
          lastRunAt: null,
        };
        map.set(key, acc);
      }
      return acc;
    };

    for (const row of rows) {
      const d = parseDetails(row.details);
      if (row.eventName === "agent:registered") {
        const key = asString(d["agentId"]);
        if (!key) continue;
        const acc = ensure(key, "registered");
        acc.model = asString(d["model"]) ?? acc.model;
        acc.description = asString(d["description"]) ?? acc.description;
        continue;
      }
      const suffix = row.eventName.split(":").pop();
      const agentName = asString(d["agentName"]);
      const routeId = asString(d["routeId"]) ?? "";
      const key = agentName ?? routeId;
      if (!key) continue;
      const acc = ensure(key, agentName ? "registered" : "inline");
      acc.model = asString(d["model"]) ?? acc.model;
      acc.lastRunAt = row.timestamp;
      if (suffix === "started") {
        const exId = row.exchangeId ?? asString(d["exchangeId"]);
        if (exId) acc.runs.add(exId);
      } else if (suffix === "finished") {
        acc.totalTokens += asNumber(d["totalTokens"]) ?? 0;
      } else if (suffix === "error") {
        acc.errorCount += 1;
      }
    }

    const result: AgentSummary[] = Array.from(map.values()).map((a) => ({
      key: a.key,
      source: a.source,
      model: a.model,
      description: a.description,
      runCount: a.runs.size,
      errorCount: a.errorCount,
      totalTokens: a.totalTokens,
      lastRunAt: a.lastRunAt,
    }));
    // Active agents (those that have run) first, most-recent first; then
    // registered-but-never-run agents alphabetically.
    result.sort((a, b) => {
      if (a.runCount > 0 !== b.runCount > 0) return a.runCount > 0 ? -1 : 1;
      if (a.lastRunAt && b.lastRunAt) return a.lastRunAt < b.lastRunAt ? 1 : -1;
      return a.key < b.key ? -1 : 1;
    });
    return result;
  }

  /**
   * Get the exchanges in which a given agent ran, most recent first.
   * Resolves run exchange ids from `agent:started` events, then joins the
   * `exchanges` table (synthesising a minimal row when the dispatching
   * exchange was not separately recorded).
   */
  getAgentRuns(
    agentKey: string,
    source: "registered" | "inline",
    limit = 50,
  ): TelemetryExchange[] {
    const rows = this.stmt(
      "agentStarted",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE event_name LIKE 'route:%:agent:started'
       ORDER BY id DESC`,
    ).all() as EventRow[];

    const seen = new Set<string>();
    const meta: Array<{
      exchangeId: string;
      routeId: string;
      correlationId: string;
      timestamp: string;
    }> = [];
    for (const row of rows) {
      const d = parseDetails(row.details);
      const agentName = asString(d["agentName"]);
      const routeId = asString(d["routeId"]) ?? "";
      const key = agentName ?? routeId;
      const rowSource = agentName ? "registered" : "inline";
      if (key !== agentKey || rowSource !== source) continue;
      const exId = row.exchangeId ?? asString(d["exchangeId"]);
      if (!exId || seen.has(exId)) continue;
      seen.add(exId);
      meta.push({
        exchangeId: exId,
        routeId,
        correlationId: asString(d["correlationId"]) ?? "",
        timestamp: row.timestamp,
      });
      if (meta.length >= limit) break;
    }
    if (meta.length === 0) return [];

    const placeholders = meta.map(() => "?").join(",");
    const found = this.db
      .prepare(
        `SELECT id, route_id AS routeId, context_id AS contextId,
                correlation_id AS correlationId, status,
                started_at AS startedAt, completed_at AS completedAt,
                duration_ms AS durationMs, error
         FROM exchanges WHERE id IN (${placeholders})`,
      )
      .all(...meta.map((m) => m.exchangeId)) as TelemetryExchange[];
    const foundById = new Map(found.map((e) => [e.id, e]));

    return meta.map((m) => {
      const hit = foundById.get(m.exchangeId);
      if (hit) return hit;
      return {
        id: m.exchangeId,
        routeId: m.routeId,
        contextId: "",
        correlationId: m.correlationId,
        status: "started",
        startedAt: m.timestamp,
        completedAt: null,
        durationMs: null,
        error: null,
      };
    });
  }

  /** Per-run agent detail (model, finish reason, tokens) for an exchange. */
  getAgentRunInfo(exchangeId: string): AgentRunInfo | null {
    const rows = this.stmt(
      "agentRunInfo",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE exchange_id = ?
         AND (event_name LIKE 'route:%:agent:started'
           OR event_name LIKE 'route:%:agent:finished'
           OR event_name LIKE 'route:%:agent:error')
       ORDER BY id ASC`,
    ).all(exchangeId) as EventRow[];
    if (rows.length === 0) return null;

    const info: AgentRunInfo = {
      exchangeId,
      model: null,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      status: "running",
    };
    for (const row of rows) {
      const d = parseDetails(row.details);
      const suffix = row.eventName.split(":").pop();
      info.model = asString(d["model"]) ?? info.model;
      if (suffix === "finished") {
        info.status = info.status === "error" ? "error" : "finished";
        info.finishReason = asString(d["finishReason"]) ?? info.finishReason;
        info.inputTokens = asNumber(d["inputTokens"]) ?? info.inputTokens;
        info.outputTokens = asNumber(d["outputTokens"]) ?? info.outputTokens;
        info.totalTokens = asNumber(d["totalTokens"]) ?? info.totalTokens;
      } else if (suffix === "error") {
        info.status = "error";
      }
    }
    return info;
  }

  /** Ordered tool calls made during a single agent run (exchange). */
  getAgentRunToolCalls(exchangeId: string): ToolCallRow[] {
    const rows = this.stmt(
      "agentRunToolCalls",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE exchange_id = ? AND event_name LIKE 'route:%:agent:tool:%'
       ORDER BY id ASC`,
    ).all(exchangeId) as EventRow[];
    return correlateToolCalls(rows);
  }

  // -- Tools tab --

  /**
   * List tools derived from registration (`agent:tool:registered`) and
   * invocation (`route:*:agent:tool:invoked|error`) events.
   */
  getTools(): ToolSummary[] {
    const rows = this.stmt(
      "toolLifecycle",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE event_name = 'agent:tool:registered'
          OR event_name LIKE 'route:%:agent:tool:invoked'
          OR event_name LIKE 'route:%:agent:tool:error'
       ORDER BY id ASC`,
    ).all() as EventRow[];

    interface Acc {
      name: string;
      source: "registered" | "observed";
      callCount: number;
      errorCount: number;
      lastCalledAt: string | null;
    }
    const map = new Map<string, Acc>();
    const ensure = (name: string, source: "registered" | "observed"): Acc => {
      let acc = map.get(name);
      if (!acc) {
        acc = { name, source, callCount: 0, errorCount: 0, lastCalledAt: null };
        map.set(name, acc);
      }
      return acc;
    };

    for (const row of rows) {
      const d = parseDetails(row.details);
      if (row.eventName === "agent:tool:registered") {
        const name = asString(d["toolName"]);
        if (name) ensure(name, "registered");
        continue;
      }
      const name = asString(d["toolName"]);
      if (!name) continue;
      const acc = ensure(name, "observed");
      const suffix = row.eventName.split(":").pop();
      if (suffix === "invoked") {
        acc.callCount += 1;
        acc.lastCalledAt = row.timestamp;
      } else if (suffix === "error") {
        acc.errorCount += 1;
        acc.lastCalledAt = row.timestamp;
      }
    }

    const result: ToolSummary[] = Array.from(map.values());
    result.sort((a, b) => {
      if (a.callCount > 0 !== b.callCount > 0) return a.callCount > 0 ? -1 : 1;
      if (a.lastCalledAt && b.lastCalledAt)
        return a.lastCalledAt < b.lastCalledAt ? 1 : -1;
      return a.name < b.name ? -1 : 1;
    });
    return result;
  }

  /** Invocation history for a single tool, most recent call first. */
  getToolCalls(toolName: string, limit = 100): ToolCallRow[] {
    const rows = this.stmt(
      "toolCalls",
      `SELECT id, timestamp, event_name AS eventName, details, exchange_id AS exchangeId
       FROM events
       WHERE event_name LIKE 'route:%:agent:tool:%'
       ORDER BY id ASC`,
    ).all() as EventRow[];
    const relevant = rows.filter(
      (r) => asString(parseDetails(r.details)["toolName"]) === toolName,
    );
    const calls = correlateToolCalls(relevant);
    calls.reverse();
    return calls.slice(0, limit);
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
