import {
  trace,
  type Tracer,
  type Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { CraftContext, CraftPlugin } from "../context.ts";
import type { EventName, EventHandler } from "../types.ts";
import type { TelemetryOptions, TelemetryEvent } from "./types.ts";
import { SqliteConnection } from "./sqlite-connection.ts";
import { SqliteSpanProcessor, ATTR, SPAN_KIND } from "./sqlite-processor.ts";
import { SqliteEventWriter } from "./sqlite-event-writer.ts";

/**
 * Tracer instrumentation version. Update when releasing a new version.
 */
const TRACER_VERSION = "0.4.0";

/**
 * Default batch size for the event writer.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Default flush interval in milliseconds.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Default maximum exchange rows for pruning.
 */
const DEFAULT_MAX_EXCHANGES = 50_000;

/**
 * Default maximum event rows for pruning.
 */
const DEFAULT_MAX_EVENTS = 100_000;

/**
 * Telemetry plugin that instruments the framework with OpenTelemetry traces
 * and persists data to SQLite for the TUI.
 *
 * Fan-out architecture:
 * - SQLite path: `SqliteSpanProcessor` (routes/exchanges) + `SqliteEventWriter` (events)
 * - External path: user's `TracerProvider` creates real OTel spans
 *
 * Both paths receive identical data.
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
 * // External provider (e.g. Better Stack)
 * telemetry({ tracerProvider: myTracerProvider })
 * ```
 */
class TelemetryPlugin implements CraftPlugin {
  private readonly options: TelemetryOptions;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private connection: SqliteConnection | undefined;
  private spanProcessor: SqliteSpanProcessor | undefined;
  private eventWriter: SqliteEventWriter | undefined;
  private tracer: Tracer | undefined;
  private unsubscribers: Array<() => void> = [];

  // Track active spans for route lifecycle (long-lived)
  private routeSpans = new Map<string, Span>();
  // Track active spans for exchange lifecycle
  private exchangeSpans = new Map<string, Span>();

  constructor(options?: TelemetryOptions) {
    this.options = options ?? {};
    const sqlite = this.options.sqlite ?? {};
    const batchSize = Math.trunc(sqlite.eventBatchSize ?? DEFAULT_BATCH_SIZE);
    const flushIntervalMs = Math.trunc(
      sqlite.eventFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.batchSize = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
    this.flushIntervalMs =
      flushIntervalMs > 0 ? flushIntervalMs : DEFAULT_FLUSH_INTERVAL_MS;
  }

  async apply(ctx: CraftContext): Promise<void> {
    // -- SQLite path --
    if (!this.options.disableSqlite) {
      const sqlite = this.options.sqlite ?? {};
      const conn = await SqliteConnection.open(
        {
          ...(sqlite.dbPath !== undefined ? { dbPath: sqlite.dbPath } : {}),
          maxExchanges: sqlite.maxExchanges ?? DEFAULT_MAX_EXCHANGES,
          maxEvents: sqlite.maxEvents ?? DEFAULT_MAX_EVENTS,
        },
        ctx.logger,
      );
      if (conn) {
        this.connection = conn;
        this.spanProcessor = new SqliteSpanProcessor(conn);
        this.eventWriter = new SqliteEventWriter(
          conn,
          this.batchSize,
          this.flushIntervalMs,
        );
      } else {
        ctx.logger.warn(
          {},
          "better-sqlite3 is not installed. Telemetry SQLite backend disabled. Install it with: pnpm add better-sqlite3",
        );
      }
    }

    // -- External OTel path --
    if (this.options.tracerProvider) {
      this.tracer = this.options.tracerProvider.getTracer(
        "routecraft",
        TRACER_VERSION,
      );
    } else if (trace.getTracerProvider() !== undefined) {
      // Use globally registered provider if no explicit one given
      // (no-op if no SDK installed)
      this.tracer = trace.getTracer("routecraft", TRACER_VERSION);
    }

    // -- Subscribe to events --
    this.subscribeAll(ctx);
    this.subscribeRouteLifecycle(ctx);
    this.subscribeExchangeLifecycle(ctx);
  }

  async teardown(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // End any lingering route spans
    for (const span of this.routeSpans.values()) {
      span.end();
    }
    this.routeSpans.clear();

    // End any lingering exchange spans
    for (const span of this.exchangeSpans.values()) {
      span.end();
    }
    this.exchangeSpans.clear();

    if (this.eventWriter) {
      this.eventWriter.close();
      this.eventWriter = undefined;
    }

    if (this.connection) {
      this.connection.close();
      this.connection = undefined;
    }
  }

  // -- Raw event log (events table) --

  private subscribeAll(ctx: CraftContext): void {
    this.unsubscribers.push(
      ctx.on("**", ((payload: {
        ts: string;
        contextId: string;
        details: unknown;
        _event?: string;
      }) => {
        if (!this.eventWriter) return;
        const d = payload.details as Record<string, unknown> | null;
        const exchangeId =
          d && typeof d["exchangeId"] === "string"
            ? d["exchangeId"]
            : undefined;
        const corrId =
          d && typeof d["correlationId"] === "string"
            ? d["correlationId"]
            : undefined;
        const event: TelemetryEvent = {
          timestamp: payload.ts,
          contextId: payload.contextId,
          eventName: payload._event ?? extractEventName(payload),
          details: safeStringify(payload.details),
        };
        if (exchangeId) event.exchangeId = exchangeId;
        if (corrId) event.correlationId = corrId;
        this.eventWriter.write(event);
      }) as EventHandler<EventName>),
    );
  }

  // -- Route lifecycle (spans) --

  private subscribeRouteLifecycle(ctx: CraftContext): void {
    // Route registered
    this.unsubscribers.push(
      ctx.on(
        "route:*:registered" as EventName,
        ((payload: {
          ts: string;
          contextId: string;
          details: { route: { definition: { id: string } } };
        }) => {
          const routeId = payload.details.route.definition.id;
          const key = `${routeId}:${payload.contextId}`;

          // SQLite
          this.spanProcessor?.writeRoute(
            routeId,
            payload.contextId,
            payload.ts,
          );

          // OTel
          if (this.tracer) {
            const span = this.tracer.startSpan(`route:${routeId}`, {
              attributes: {
                [ATTR.SPAN_KIND]: SPAN_KIND.ROUTE,
                [ATTR.ROUTE_ID]: routeId,
                [ATTR.CONTEXT_ID]: payload.contextId,
              },
            });
            this.routeSpans.set(key, span);
          }
        }) as EventHandler<EventName>,
      ),
    );

    // Route started
    this.unsubscribers.push(
      ctx.on(
        "route:*:started" as EventName,
        ((payload: {
          ts: string;
          contextId: string;
          details: { route: { definition: { id: string } } };
        }) => {
          const routeId = payload.details.route.definition.id;

          // SQLite
          this.spanProcessor?.updateRouteStatus(
            routeId,
            payload.contextId,
            "started",
          );

          // OTel: add event to existing span
          const key = `${routeId}:${payload.contextId}`;
          const span = this.routeSpans.get(key);
          span?.addEvent("started");
        }) as EventHandler<EventName>,
      ),
    );

    // Route stopped
    this.unsubscribers.push(
      ctx.on(
        "route:*:stopped" as EventName,
        ((payload: {
          ts: string;
          contextId: string;
          details: { route: { definition: { id: string } } };
        }) => {
          const routeId = payload.details.route.definition.id;

          // SQLite
          this.spanProcessor?.updateRouteStatus(
            routeId,
            payload.contextId,
            "stopped",
          );

          // OTel: end the route span
          const key = `${routeId}:${payload.contextId}`;
          const span = this.routeSpans.get(key);
          if (span) {
            span.addEvent("stopped");
            span.end();
            this.routeSpans.delete(key);
          }
        }) as EventHandler<EventName>,
      ),
    );
  }

  // -- Exchange lifecycle (spans) --

  private subscribeExchangeLifecycle(ctx: CraftContext): void {
    // Exchange started
    this.unsubscribers.push(
      ctx.on("route:*:exchange:started", ((payload: {
        ts: string;
        contextId: string;
        details: {
          routeId: string;
          exchangeId: string;
          correlationId: string;
        };
      }) => {
        const { routeId, exchangeId, correlationId } = payload.details;
        const key = `${exchangeId}:${payload.contextId}`;

        // SQLite
        this.spanProcessor?.writeExchange(
          exchangeId,
          routeId,
          payload.contextId,
          correlationId,
          payload.ts,
        );

        // OTel
        if (this.tracer) {
          const span = this.tracer.startSpan(`exchange:${exchangeId}`, {
            attributes: {
              [ATTR.SPAN_KIND]: SPAN_KIND.EXCHANGE,
              [ATTR.ROUTE_ID]: routeId,
              [ATTR.EXCHANGE_ID]: exchangeId,
              [ATTR.CORRELATION_ID]: correlationId,
              [ATTR.CONTEXT_ID]: payload.contextId,
            },
          });
          this.exchangeSpans.set(key, span);
        }
      }) as EventHandler<EventName>),
    );

    // Exchange completed
    this.unsubscribers.push(
      ctx.on("route:*:exchange:completed", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; duration: number };
      }) => {
        const { exchangeId, duration } = payload.details;
        const key = `${exchangeId}:${payload.contextId}`;

        // SQLite
        this.spanProcessor?.completeExchange(
          exchangeId,
          payload.contextId,
          payload.ts,
          duration,
        );

        // OTel
        const span = this.exchangeSpans.get(key);
        if (span) {
          span.setAttribute(ATTR.DURATION_MS, duration);
          span.end();
          this.exchangeSpans.delete(key);
        }
      }) as EventHandler<EventName>),
    );

    // Exchange failed
    this.unsubscribers.push(
      ctx.on("route:*:exchange:failed", ((payload: {
        ts: string;
        contextId: string;
        details: {
          exchangeId: string;
          duration: number;
          error: unknown;
        };
      }) => {
        const { exchangeId, duration, error } = payload.details;
        const key = `${exchangeId}:${payload.contextId}`;
        const errorStr = error instanceof Error ? error.message : String(error);

        // SQLite
        this.spanProcessor?.failExchange(
          exchangeId,
          payload.contextId,
          payload.ts,
          duration,
          errorStr,
        );

        // OTel
        const span = this.exchangeSpans.get(key);
        if (span) {
          span.setAttribute(ATTR.DURATION_MS, duration);
          span.setAttribute(ATTR.ERROR, errorStr);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorStr,
          });
          span.end();
          this.exchangeSpans.delete(key);
        }
      }) as EventHandler<EventName>),
    );

    // Exchange dropped
    this.unsubscribers.push(
      ctx.on("route:*:exchange:dropped", ((payload: {
        ts: string;
        contextId: string;
        details: { exchangeId: string; reason?: string };
      }) => {
        const { exchangeId, reason } = payload.details;
        const key = `${exchangeId}:${payload.contextId}`;
        const dropReason = reason ?? "dropped";

        // SQLite
        this.spanProcessor?.dropExchange(
          exchangeId,
          payload.contextId,
          payload.ts,
          dropReason,
        );

        // OTel
        const span = this.exchangeSpans.get(key);
        if (span) {
          span.setAttribute(ATTR.DROPPED, true);
          span.setAttribute(ATTR.DROP_REASON, dropReason);
          span.end();
          this.exchangeSpans.delete(key);
        }
      }) as EventHandler<EventName>),
    );
  }
}

/**
 * Create a telemetry plugin that instruments the framework with
 * OpenTelemetry traces and persists data to SQLite for the TUI.
 *
 * When no `tracerProvider` is given and `disableSqlite` is false (default),
 * events are persisted to a local SQLite database for the TUI to read.
 *
 * @experimental
 * @param options - TracerProvider, SQLite path, and buffer configuration
 * @returns A CraftPlugin instance
 *
 * @example
 * ```typescript
 * import { telemetry } from "@routecraft/routecraft";
 *
 * // Default SQLite backend
 * telemetry()
 *
 * // Export to Better Stack via OTLP
 * telemetry({ tracerProvider: myTracerProvider })
 *
 * // External only, no SQLite
 * telemetry({ tracerProvider, disableSqlite: true })
 * ```
 */
export function telemetry(options?: TelemetryOptions): CraftPlugin {
  return new TelemetryPlugin(options);
}

/**
 * Safely stringify a value to JSON, handling circular references.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          ...(typeof val.stack === "string" ? { stack: val.stack } : {}),
        };
      }
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
      if (val && typeof val === "object") {
        if (seen.has(val as object)) return "[Circular]";
        seen.add(val as object);
      }
      return val;
    });
  } catch (err) {
    return JSON.stringify({ _serializationError: String(err) });
  }
}

/**
 * Extract a meaningful event name from a wildcard payload.
 *
 * This is a best-effort fallback for events that lack the `_event` field.
 * The `_event` field (checked by the caller) is the authoritative source.
 * These heuristics infer the event name from payload shape and may
 * misclassify events with overlapping fields.
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

  if ("routeId" in d && "operation" in d) {
    const routeId = d["routeId"] as string;
    if ("duration" in d) return `route:${routeId}:step:completed`;
    return `route:${routeId}:step:started`;
  }

  if ("pluginId" in d) return "plugin:event";
  if ("error" in d && !("routeId" in d)) return "error";

  return "context:event";
}
