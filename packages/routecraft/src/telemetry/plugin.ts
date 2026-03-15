import type { CraftContext, CraftPlugin } from "../context.ts";
import type { EventName, EventHandler } from "../types.ts";
import type {
  TelemetryOptions,
  TelemetrySink,
  TelemetryEvent,
} from "./types.ts";
import { SqliteTelemetrySink } from "./sqlite-sink.ts";

/**
 * Default batch size for buffered writes.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Default flush interval in milliseconds.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Telemetry plugin that subscribes to all framework events and delegates
 * writes to a pluggable {@link TelemetrySink}.
 *
 * When no custom sink is provided, the built-in {@link SqliteTelemetrySink}
 * is used, persisting to `.routecraft/telemetry.db`.
 *
 * Events are buffered and flushed in batches for performance. The plugin
 * never blocks the main thread or slows route execution.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { telemetry } from "@routecraft/routecraft";
 *
 * // Default SQLite sink
 * telemetry()
 *
 * // Custom sink
 * telemetry({ sink: myOtelSink })
 * ```
 */
class TelemetryPlugin implements CraftPlugin {
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly providedSink: TelemetrySink | undefined;
  private readonly sqliteOptions: { dbPath?: string; walMode?: boolean };

  private sink: TelemetrySink | undefined;
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribers: Array<() => void> = [];

  constructor(options?: TelemetryOptions) {
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs =
      options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.providedSink = options?.sink;
    // Preserve any extra keys the caller passed for the default SQLite sink.
    // TelemetryOptions no longer has dbPath/walMode, but callers migrating
    // from the previous API may still pass them. We forward them silently.
    const raw = (options ?? {}) as Record<string, unknown>;
    const dbPath =
      typeof raw["dbPath"] === "string" ? raw["dbPath"] : undefined;
    const walMode =
      typeof raw["walMode"] === "boolean" ? raw["walMode"] : undefined;
    this.sqliteOptions = {
      ...(dbPath !== undefined ? { dbPath } : {}),
      ...(walMode !== undefined ? { walMode } : {}),
    };
  }

  async apply(ctx: CraftContext): Promise<void> {
    // Resolve sink
    if (this.providedSink) {
      this.sink = this.providedSink;
    } else {
      const sqliteSink = new SqliteTelemetrySink();
      const opened = await sqliteSink.open(this.sqliteOptions);
      if (!opened) {
        ctx.logger.warn(
          {},
          "better-sqlite3 is not installed. Telemetry plugin disabled. Install it with: pnpm add better-sqlite3",
        );
        return;
      }
      this.sink = sqliteSink;
    }

    // Subscribe to all events for the raw event log
    this.unsubscribers.push(
      ctx.on("**", ((payload: {
        ts: string;
        contextId: string;
        details: unknown;
      }) => {
        this.bufferEvent(payload);
      }) as EventHandler<EventName>),
    );

    // Route lifecycle
    this.unsubscribers.push(
      ctx.on("route:registered", (payload) => {
        this.sink!.writeRoute({
          id: payload.details.route.definition.id,
          contextId: payload.contextId,
          registeredAt: payload.ts,
          status: "registered",
        });
      }),
    );

    this.unsubscribers.push(
      ctx.on("route:started", (payload) => {
        this.sink!.updateRouteStatus(
          payload.details.route.definition.id,
          payload.contextId,
          "started",
        );
      }),
    );

    this.unsubscribers.push(
      ctx.on("route:stopped", (payload) => {
        this.sink!.updateRouteStatus(
          payload.details.route.definition.id,
          payload.contextId,
          "stopped",
        );
      }),
    );

    // Exchange lifecycle (wildcard, cast to avoid union narrowing issues)
    this.unsubscribers.push(
      ctx.on("route:*:exchange:started", ((payload: {
        ts: string;
        contextId: string;
        details: { routeId: string; exchangeId: string; correlationId: string };
      }) => {
        this.sink!.writeExchange({
          id: payload.details.exchangeId,
          routeId: payload.details.routeId,
          contextId: payload.contextId,
          correlationId: payload.details.correlationId,
          status: "started",
          startedAt: payload.ts,
          completedAt: null,
          durationMs: null,
          error: null,
        });
      }) as EventHandler<EventName>),
    );

    this.unsubscribers.push(
      ctx.on("route:*:exchange:completed", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; duration: number };
      }) => {
        this.sink!.completeExchange(
          payload.details.exchangeId,
          payload.contextId,
          payload.ts,
          payload.details.duration,
        );
      }) as EventHandler<EventName>),
    );

    this.unsubscribers.push(
      ctx.on("route:*:exchange:failed", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; duration: number; error: unknown };
      }) => {
        const errorStr =
          payload.details.error instanceof Error
            ? payload.details.error.message
            : String(payload.details.error);
        this.sink!.failExchange(
          payload.details.exchangeId,
          payload.contextId,
          payload.ts,
          payload.details.duration,
          errorStr,
        );
      }) as EventHandler<EventName>),
    );

    // Flush timer
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);

    if (
      this.flushTimer &&
      typeof this.flushTimer === "object" &&
      "unref" in this.flushTimer
    ) {
      this.flushTimer.unref();
    }
  }

  async teardown(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.flush();

    if (this.sink) {
      await this.sink.close();
      this.sink = undefined;
    }
  }

  private bufferEvent(payload: {
    ts: string;
    contextId: string;
    details: unknown;
  }): void {
    this.buffer.push({
      timestamp: payload.ts,
      contextId: payload.contextId,
      eventName: extractEventName(payload),
      details: safeStringify(payload.details),
    });

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0 || !this.sink) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.sink.writeEvents(batch);
  }
}

/**
 * Create a telemetry plugin that persists framework events to a pluggable sink.
 *
 * When no `sink` is provided, the built-in SQLite sink is used (requires `better-sqlite3`).
 *
 * @experimental
 * @param options - Sink, batch size, and flush interval configuration
 * @returns A CraftPlugin instance
 *
 * @example
 * ```typescript
 * import { telemetry } from "@routecraft/routecraft";
 *
 * // Default SQLite sink
 * telemetry()
 *
 * // Custom sink
 * telemetry({ sink: myCustomSink })
 * ```
 */
export function telemetry(options?: TelemetryOptions): CraftPlugin {
  return new TelemetryPlugin(options);
}

/**
 * Safely stringify a value to JSON, handling circular references.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
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
 */
function extractEventName(payload: { details: unknown }): string {
  const d = payload.details as Record<string, unknown> | null;
  if (!d) return "unknown";

  if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
    const route = d["route"] as { definition?: { id?: string } };
    if (route.definition?.id) {
      if ("reason" in d) return "route:stopping";
      return "route:event";
    }
  }

  if ("routeId" in d && "exchangeId" in d) {
    const routeId = d["routeId"] as string;
    if ("error" in d && "duration" in d)
      return `route:${routeId}:exchange:failed`;
    if ("duration" in d) return `route:${routeId}:exchange:completed`;
    return `route:${routeId}:exchange:started`;
  }

  if ("routeId" in d && "operation" in d && "adapterId" in d) {
    const routeId = d["routeId"] as string;
    const adapterId = d["adapterId"] as string;
    const op = d["operation"] as string;
    if ("duration" in d)
      return `route:${routeId}:operation:${op}:${adapterId}:stopped`;
    return `route:${routeId}:operation:${op}:${adapterId}:started`;
  }

  if ("pluginId" in d) return "plugin:event";
  if ("error" in d && !("routeId" in d)) return "error";

  return "context:event";
}
