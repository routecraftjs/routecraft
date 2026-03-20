import type { SqliteConnection } from "./sqlite-connection.ts";
import type { TelemetryLogger } from "./types.ts";

/**
 * Semantic attribute keys used by the telemetry plugin to tag spans.
 */
export const ATTR = {
  SPAN_KIND: "routecraft.span.kind",
  ROUTE_ID: "routecraft.route.id",
  CONTEXT_ID: "routecraft.context.id",
  EXCHANGE_ID: "routecraft.exchange.id",
  CORRELATION_ID: "routecraft.correlation.id",
  DURATION_MS: "routecraft.duration_ms",
  DROP_REASON: "routecraft.drop.reason",
  DROPPED: "routecraft.dropped",
  ERROR: "routecraft.error",
  OPERATION_TYPE: "routecraft.operation.type",
  ADAPTER_ID: "routecraft.adapter.id",
} as const;

/**
 * Span kind values used to identify what a span represents.
 */
export const SPAN_KIND = {
  ROUTE: "route",
  EXCHANGE: "exchange",
  OPERATION: "operation",
} as const;

/**
 * Duck-typed OTel ReadableSpan for use in `onEnd`.
 * Only the fields SqliteSpanProcessor actually reads.
 */
interface OTelReadableSpan {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  startTime: [number, number]; // [seconds, nanoseconds]
  endTime: [number, number];
}

/**
 * Duck-typed OTel Span for use in `onStart`.
 */
interface OTelSpan {
  setAttribute(key: string, value: unknown): void;
  attributes?: Record<string, unknown>;
  spanContext?(): { traceId: string; spanId: string };
}

/**
 * SQLite-backed SpanProcessor that writes route and exchange lifecycle
 * data to the `routes` and `exchanges` tables.
 *
 * Implements the OTel SpanProcessor interface via duck typing so
 * `@opentelemetry/sdk-trace-base` is not required at runtime for
 * the default SQLite path.
 *
 * The plugin calls `onStart`/`onEnd` directly from event handlers;
 * it also works when registered with a `BasicTracerProvider` for
 * external export scenarios.
 */
export class SqliteSpanProcessor {
  private readonly logger: TelemetryLogger | undefined;
  private readonly upsertRouteStmt: { run(...params: unknown[]): unknown };
  private readonly updateRouteStatusStmt: {
    run(...params: unknown[]): unknown;
  };
  private readonly insertExchangeStmt: { run(...params: unknown[]): unknown };
  private readonly updateExchangeCompletedStmt: {
    run(...params: unknown[]): unknown;
  };
  private readonly updateExchangeFailedStmt: {
    run(...params: unknown[]): unknown;
  };
  private readonly updateExchangeDroppedStmt: {
    run(...params: unknown[]): unknown;
  };

  constructor(connection: SqliteConnection) {
    this.logger = connection.logger;
    this.upsertRouteStmt = connection.db.prepare(
      `INSERT INTO routes (id, context_id, registered_at, status)
       VALUES (?, ?, ?, 'registered')
       ON CONFLICT(id, context_id) DO UPDATE SET status = 'registered'`,
    );

    this.updateRouteStatusStmt = connection.db.prepare(
      "UPDATE routes SET status = ? WHERE id = ? AND context_id = ?",
    );

    this.insertExchangeStmt = connection.db.prepare(
      `INSERT OR IGNORE INTO exchanges (id, route_id, context_id, correlation_id, status, started_at)
       VALUES (?, ?, ?, ?, 'started', ?)`,
    );

    this.updateExchangeCompletedStmt = connection.db.prepare(
      `UPDATE exchanges SET status = 'completed', completed_at = ?, duration_ms = ?
       WHERE id = ? AND context_id = ?`,
    );

    this.updateExchangeFailedStmt = connection.db.prepare(
      `UPDATE exchanges SET status = 'failed', completed_at = ?, duration_ms = ?, error = ?
       WHERE id = ? AND context_id = ?`,
    );

    this.updateExchangeDroppedStmt = connection.db.prepare(
      `UPDATE exchanges SET status = 'dropped', completed_at = ?, duration_ms = 0, error = ?
       WHERE id = ? AND context_id = ?`,
    );
  }

  // -- Direct API (called by plugin without OTel SDK) --

  writeRoute(routeId: string, contextId: string, registeredAt: string): void {
    try {
      this.upsertRouteStmt.run(routeId, contextId, registeredAt);
    } catch (err) {
      this.logger?.warn({ err, routeId }, "Failed to write telemetry route");
    }
  }

  updateRouteStatus(routeId: string, contextId: string, status: string): void {
    try {
      this.updateRouteStatusStmt.run(status, routeId, contextId);
    } catch (err) {
      this.logger?.warn(
        { err, routeId, status },
        "Failed to update telemetry route status",
      );
    }
  }

  writeExchange(
    exchangeId: string,
    routeId: string,
    contextId: string,
    correlationId: string,
    startedAt: string,
  ): void {
    try {
      this.insertExchangeStmt.run(
        exchangeId,
        routeId,
        contextId,
        correlationId,
        startedAt,
      );
    } catch (err) {
      this.logger?.warn(
        { err, exchangeId, routeId },
        "Failed to write telemetry exchange",
      );
    }
  }

  completeExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
  ): void {
    try {
      this.updateExchangeCompletedStmt.run(
        completedAt,
        durationMs,
        exchangeId,
        contextId,
      );
    } catch (err) {
      this.logger?.warn(
        { err, exchangeId },
        "Failed to complete telemetry exchange",
      );
    }
  }

  failExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
    error: string,
  ): void {
    try {
      this.updateExchangeFailedStmt.run(
        completedAt,
        durationMs,
        error,
        exchangeId,
        contextId,
      );
    } catch (err) {
      this.logger?.warn(
        { err, exchangeId },
        "Failed to record telemetry exchange failure",
      );
    }
  }

  dropExchange(
    exchangeId: string,
    contextId: string,
    droppedAt: string,
    reason: string,
  ): void {
    try {
      this.updateExchangeDroppedStmt.run(
        droppedAt,
        reason,
        exchangeId,
        contextId,
      );
    } catch (err) {
      this.logger?.warn(
        { err, exchangeId },
        "Failed to record telemetry exchange drop",
      );
    }
  }

  // -- OTel SpanProcessor interface (duck-typed) --

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- OTel SpanProcessor interface requires this parameter
  onStart(span: OTelSpan, _parentContext?: unknown): void {
    const attrs = span.attributes ?? ({} as Record<string, unknown>);
    const kind = attrs[ATTR.SPAN_KIND] as string | undefined;
    if (!kind) return;

    const contextId = attrs[ATTR.CONTEXT_ID] as string;
    const ts = new Date().toISOString();

    if (kind === SPAN_KIND.ROUTE) {
      const routeId = attrs[ATTR.ROUTE_ID] as string;
      this.writeRoute(routeId, contextId, ts);
    } else if (kind === SPAN_KIND.EXCHANGE) {
      const exchangeId = attrs[ATTR.EXCHANGE_ID] as string;
      const routeId = attrs[ATTR.ROUTE_ID] as string;
      const correlationId = attrs[ATTR.CORRELATION_ID] as string;
      this.writeExchange(exchangeId, routeId, contextId, correlationId, ts);
    }
  }

  onEnd(span: OTelReadableSpan): void {
    const attrs = span.attributes;
    const kind = attrs[ATTR.SPAN_KIND] as string | undefined;
    if (!kind) return;

    const contextId = attrs[ATTR.CONTEXT_ID] as string;
    const ts = new Date().toISOString();

    if (kind === SPAN_KIND.ROUTE) {
      const routeId = attrs[ATTR.ROUTE_ID] as string;
      this.updateRouteStatus(routeId, contextId, "stopped");
    } else if (kind === SPAN_KIND.EXCHANGE) {
      const exchangeId = attrs[ATTR.EXCHANGE_ID] as string;
      const durationMs = Number(attrs[ATTR.DURATION_MS] ?? 0);

      if (attrs[ATTR.DROPPED]) {
        const reason = (attrs[ATTR.DROP_REASON] as string) ?? "dropped";
        this.dropExchange(exchangeId, contextId, ts, reason);
      } else if (span.status.code === 2) {
        // SpanStatusCode.ERROR = 2
        const error =
          (attrs[ATTR.ERROR] as string) ?? span.status.message ?? "unknown";
        this.failExchange(exchangeId, contextId, ts, durationMs, error);
      } else {
        this.completeExchange(exchangeId, contextId, ts, durationMs);
      }
    }
  }

  async forceFlush(): Promise<void> {
    // Writes are synchronous, nothing to flush
  }

  async shutdown(): Promise<void> {
    // Connection lifecycle managed by SqliteConnection
  }
}
