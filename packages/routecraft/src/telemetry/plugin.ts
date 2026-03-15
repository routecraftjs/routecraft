import { mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import type { CraftContext, CraftPlugin } from "../context.ts";
import type { EventName, EventHandler } from "../types.ts";
import type { TelemetryOptions } from "./types.ts";
import { ALL_DDL } from "./schema.ts";

/**
 * Default path for the telemetry database, relative to cwd.
 */
const DEFAULT_DB_PATH = ".routecraft/telemetry.db";

/**
 * Default batch size for buffered writes.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Default flush interval in milliseconds.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Buffered event waiting to be written to SQLite.
 */
interface BufferedEvent {
  timestamp: string;
  contextId: string;
  eventName: string;
  details: string;
}

/**
 * Telemetry plugin that persists framework events to a local SQLite database.
 *
 * The plugin subscribes to all framework events via wildcard listeners and
 * asynchronously writes them to `.routecraft/telemetry.db` (configurable).
 * SQLite is configured in WAL mode for concurrent read/write so that the
 * TUI viewer can read the database while the engine is running.
 *
 * Events are buffered and flushed in batches for performance. The plugin
 * never blocks the main thread or slows route execution.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { CraftContext } from "@routecraft/routecraft";
 * import { TelemetryPlugin } from "@routecraft/routecraft/telemetry";
 *
 * const ctx = new CraftContext({
 *   plugins: [new TelemetryPlugin()],
 * });
 * ```
 */
export class TelemetryPlugin implements CraftPlugin {
  private readonly dbPath: string;
  private readonly walMode: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  /** The better-sqlite3 database instance (typed as `unknown` to avoid hard dep). */
  private db: BetterSqlite3Database | undefined;

  /** Prepared statement for inserting events. */
  private insertEventStmt: BetterSqlite3Statement | undefined;

  /** Prepared statement for inserting/updating routes. */
  private upsertRouteStmt: BetterSqlite3Statement | undefined;

  /** Prepared statement for updating route status. */
  private updateRouteStatusStmt: BetterSqlite3Statement | undefined;

  /** Prepared statement for inserting exchanges. */
  private insertExchangeStmt: BetterSqlite3Statement | undefined;

  /** Prepared statement for updating exchange completion. */
  private updateExchangeCompletedStmt: BetterSqlite3Statement | undefined;

  /** Prepared statement for updating exchange failure. */
  private updateExchangeFailedStmt: BetterSqlite3Statement | undefined;

  /** Buffered events waiting to be flushed. */
  private buffer: BufferedEvent[] = [];

  /** Flush timer handle. */
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  /** Unsubscribe functions for event listeners. */
  private unsubscribers: Array<() => void> = [];

  constructor(options?: TelemetryOptions) {
    const dbPathRaw = options?.dbPath ?? DEFAULT_DB_PATH;
    this.dbPath = isAbsolute(dbPathRaw)
      ? dbPathRaw
      : resolve(process.cwd(), dbPathRaw);
    this.walMode = options?.walMode !== false;
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs =
      options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /**
   * Initialize the telemetry database and subscribe to all framework events.
   *
   * @param ctx - The CraftContext to attach to
   */
  async apply(ctx: CraftContext): Promise<void> {
    // Ensure directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // Dynamically import better-sqlite3 so it remains an optional dependency
    let Database: BetterSqlite3Constructor;
    try {
      const mod = await import("better-sqlite3");
      Database = (mod.default ?? mod) as BetterSqlite3Constructor;
    } catch {
      ctx.logger.warn(
        {},
        "better-sqlite3 is not installed. Telemetry plugin disabled. Install it with: pnpm add better-sqlite3",
      );
      return;
    }

    this.db = new Database(this.dbPath);

    // Enable WAL mode for concurrent reads
    if (this.walMode) {
      (this.db as BetterSqlite3Database).pragma("journal_mode = WAL");
    }

    // Create tables and indexes
    for (const ddl of ALL_DDL) {
      (this.db as BetterSqlite3Database).exec(ddl);
    }

    // Prepare statements
    this.insertEventStmt = (this.db as BetterSqlite3Database).prepare(
      "INSERT INTO events (timestamp, context_id, event_name, details) VALUES (?, ?, ?, ?)",
    );

    this.upsertRouteStmt = (this.db as BetterSqlite3Database).prepare(
      `INSERT INTO routes (id, context_id, registered_at, status)
       VALUES (?, ?, ?, 'registered')
       ON CONFLICT(id, context_id) DO UPDATE SET status = 'registered'`,
    );

    this.updateRouteStatusStmt = (this.db as BetterSqlite3Database).prepare(
      "UPDATE routes SET status = ? WHERE id = ? AND context_id = ?",
    );

    this.insertExchangeStmt = (this.db as BetterSqlite3Database).prepare(
      `INSERT OR IGNORE INTO exchanges (id, route_id, context_id, correlation_id, status, started_at)
       VALUES (?, ?, ?, ?, 'started', ?)`,
    );

    this.updateExchangeCompletedStmt = (
      this.db as BetterSqlite3Database
    ).prepare(
      `UPDATE exchanges SET status = 'completed', completed_at = ?, duration_ms = ?
       WHERE id = ? AND context_id = ?`,
    );

    this.updateExchangeFailedStmt = (this.db as BetterSqlite3Database).prepare(
      `UPDATE exchanges SET status = 'failed', completed_at = ?, duration_ms = ?, error = ?
       WHERE id = ? AND context_id = ?`,
    );

    // Subscribe to all events using globstar wildcard.
    // Use the string overload of ctx.on() so the handler receives a loosely-typed payload.
    this.unsubscribers.push(
      ctx.on("**", ((payload: {
        ts: string;
        contextId: string;
        details: unknown;
      }) => {
        this.handleEvent("**", payload);
      }) as EventHandler<EventName>),
    );

    // Subscribe to specific lifecycle events for structured tracking
    this.unsubscribers.push(
      ctx.on("route:registered", (payload) => {
        this.handleRouteRegistered(payload);
      }),
    );

    this.unsubscribers.push(
      ctx.on("route:started", (payload) => {
        this.handleRouteStatus("started", payload);
      }),
    );

    this.unsubscribers.push(
      ctx.on("route:stopped", (payload) => {
        this.handleRouteStatus("stopped", payload);
      }),
    );

    // Exchange events via wildcard (string overload avoids union type narrowing issues)
    this.unsubscribers.push(
      ctx.on("route:*:exchange:started", ((payload: {
        ts: string;
        contextId: string;
        details: { routeId: string; exchangeId: string; correlationId: string };
      }) => {
        this.handleExchangeStarted(payload);
      }) as EventHandler<EventName>),
    );

    this.unsubscribers.push(
      ctx.on("route:*:exchange:completed", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; duration: number };
      }) => {
        this.handleExchangeCompleted(payload);
      }) as EventHandler<EventName>),
    );

    this.unsubscribers.push(
      ctx.on("route:*:exchange:failed", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; duration: number; error: unknown };
      }) => {
        this.handleExchangeFailed(payload);
      }) as EventHandler<EventName>),
    );

    // Start flush timer
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);

    // Unref the timer so it does not prevent process exit
    if (
      this.flushTimer &&
      typeof this.flushTimer === "object" &&
      "unref" in this.flushTimer
    ) {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush buffered events and close the database.
   */
  async teardown(): Promise<void> {
    // Stop flush timer
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Unsubscribe from all events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Final flush
    this.flush();

    // Close database
    if (this.db) {
      (this.db as BetterSqlite3Database).close();
      this.db = undefined;
    }
  }

  /**
   * Handle any event: buffer it for batch insertion.
   */
  private handleEvent(
    _pattern: string,
    payload: { ts: string; contextId: string; details: unknown },
  ): void {
    const details = safeStringify(payload.details);
    this.buffer.push({
      timestamp: payload.ts,
      contextId: payload.contextId,
      eventName: _pattern === "**" ? extractEventName(payload) : _pattern,
      details,
    });

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Handle route:registered event.
   */
  private handleRouteRegistered(payload: {
    ts: string;
    contextId: string;
    details: { route: { definition: { id: string } } };
  }): void {
    if (!this.upsertRouteStmt) return;
    try {
      this.upsertRouteStmt.run(
        payload.details.route.definition.id,
        payload.contextId,
        payload.ts,
      );
    } catch {
      // Non-blocking: swallow DB errors
    }
  }

  /**
   * Handle route status change events (started, stopped).
   */
  private handleRouteStatus(
    status: string,
    payload: {
      ts: string;
      contextId: string;
      details: { route: { definition: { id: string } } };
    },
  ): void {
    if (!this.updateRouteStatusStmt) return;
    try {
      this.updateRouteStatusStmt.run(
        status,
        payload.details.route.definition.id,
        payload.contextId,
      );
    } catch {
      // Non-blocking: swallow DB errors
    }
  }

  /**
   * Handle exchange:started event.
   */
  private handleExchangeStarted(payload: {
    ts: string;
    contextId: string;
    details: {
      routeId: string;
      exchangeId: string;
      correlationId: string;
    };
  }): void {
    if (!this.insertExchangeStmt) return;
    try {
      this.insertExchangeStmt.run(
        payload.details.exchangeId,
        payload.details.routeId,
        payload.contextId,
        payload.details.correlationId,
        payload.ts,
      );
    } catch {
      // Non-blocking: swallow DB errors
    }
  }

  /**
   * Handle exchange:completed event.
   */
  private handleExchangeCompleted(payload: {
    ts: string;
    contextId: string;
    details: {
      exchangeId: string;
      duration: number;
    };
  }): void {
    if (!this.updateExchangeCompletedStmt) return;
    try {
      this.updateExchangeCompletedStmt.run(
        payload.ts,
        payload.details.duration,
        payload.details.exchangeId,
        payload.contextId,
      );
    } catch {
      // Non-blocking: swallow DB errors
    }
  }

  /**
   * Handle exchange:failed event.
   */
  private handleExchangeFailed(payload: {
    ts: string;
    contextId: string;
    details: {
      exchangeId: string;
      duration: number;
      error: unknown;
    };
  }): void {
    if (!this.updateExchangeFailedStmt) return;
    try {
      const errorStr =
        payload.details.error instanceof Error
          ? payload.details.error.message
          : String(payload.details.error);
      this.updateExchangeFailedStmt.run(
        payload.ts,
        payload.details.duration,
        errorStr,
        payload.details.exchangeId,
        payload.contextId,
      );
    } catch {
      // Non-blocking: swallow DB errors
    }
  }

  /**
   * Flush buffered events to the database in a single transaction.
   */
  private flush(): void {
    if (this.buffer.length === 0 || !this.db || !this.insertEventStmt) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const insertMany = (this.db as BetterSqlite3Database).transaction(
        (events: BufferedEvent[]) => {
          for (const event of events) {
            this.insertEventStmt!.run(
              event.timestamp,
              event.contextId,
              event.eventName,
              event.details,
            );
          }
        },
      );
      insertMany(batch);
    } catch {
      // Non-blocking: swallow DB errors to never affect the running engine
    }
  }
}

/**
 * Safely stringify a value to JSON, handling circular references.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      // Skip Route/CraftContext objects to avoid circular refs and huge payloads
      if (
        val &&
        typeof val === "object" &&
        "definition" in val &&
        "context" in val
      ) {
        const route = val as { definition: { id: string } };
        return { routeId: route.definition.id };
      }
      if (
        val &&
        typeof val === "object" &&
        "contextId" in val &&
        "routes" in val
      ) {
        const ctx = val as { contextId: string };
        return { contextId: ctx.contextId };
      }
      return val;
    });
  } catch {
    return "{}";
  }
}

/**
 * Extract a meaningful event name from a wildcard payload.
 * The globstar handler receives all events but does not know the event name directly.
 * We derive a name from the payload details when possible.
 */
function extractEventName(payload: { details: unknown }): string {
  const d = payload.details as Record<string, unknown> | null;
  if (!d) return "unknown";

  // Route lifecycle events have a route property
  if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
    const route = d["route"] as { definition?: { id?: string } };
    if (route.definition?.id) {
      if ("reason" in d) return "route:stopping";
      return "route:event";
    }
  }

  // Exchange events have routeId + exchangeId
  if ("routeId" in d && "exchangeId" in d) {
    const routeId = d["routeId"] as string;
    if ("error" in d && "duration" in d)
      return `route:${routeId}:exchange:failed`;
    if ("duration" in d) return `route:${routeId}:exchange:completed`;
    return `route:${routeId}:exchange:started`;
  }

  // Operation events
  if ("routeId" in d && "operation" in d && "adapterId" in d) {
    const routeId = d["routeId"] as string;
    const adapterId = d["adapterId"] as string;
    const op = d["operation"] as string;
    if ("duration" in d)
      return `route:${routeId}:operation:${op}:${adapterId}:stopped`;
    return `route:${routeId}:operation:${op}:${adapterId}:started`;
  }

  // Plugin events
  if ("pluginId" in d) {
    return "plugin:event";
  }

  // Error events
  if ("error" in d && !("routeId" in d)) {
    return "error";
  }

  // Context events
  return "context:event";
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
