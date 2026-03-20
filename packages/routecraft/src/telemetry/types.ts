import type { TracerProvider } from "@opentelemetry/api";

/**
 * SQLite-specific options for the telemetry plugin.
 *
 * These settings only apply when the SQLite backend is active.
 *
 * @experimental
 */
export interface TelemetrySqliteOptions {
  /**
   * Path to the SQLite database file.
   * Defaults to `.routecraft/telemetry.db` in the current working directory.
   */
  dbPath?: string;

  /**
   * Maximum number of events to buffer before flushing to the SQLite
   * `events` table. Defaults to `50`.
   */
  eventBatchSize?: number;

  /**
   * Maximum time in milliseconds between event flushes.
   * Defaults to `1000` (1 second).
   */
  eventFlushIntervalMs?: number;

  /**
   * Maximum number of exchange rows to keep in the database.
   * Older exchanges are pruned periodically. Set to `0` to disable pruning.
   * Defaults to `50000`.
   */
  maxExchanges?: number;

  /**
   * Maximum number of event rows to keep in the database.
   * Older events are pruned periodically. Set to `0` to disable pruning.
   * Defaults to `100000`.
   */
  maxEvents?: number;
}

/**
 * Configuration options for the telemetry plugin.
 *
 * @experimental
 */
export interface TelemetryOptions {
  /**
   * External OTel TracerProvider. When provided, spans are created via
   * this provider in addition to the default SQLite backend.
   *
   * Install `@opentelemetry/sdk-trace-base` and an exporter to use:
   *
   * @example
   * ```typescript
   * import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
   * import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
   *
   * const tracerProvider = new BasicTracerProvider()
   * tracerProvider.addSpanProcessor(
   *   new BatchSpanProcessor(new OTLPTraceExporter({ url: '...' }))
   * )
   * tracerProvider.register()
   *
   * telemetry({ tracerProvider })
   * ```
   */
  tracerProvider?: TracerProvider;

  /**
   * Disable the default SQLite backend. Only use when providing your
   * own `tracerProvider` for external export.
   *
   * Defaults to `false`.
   */
  disableSqlite?: boolean;

  /**
   * SQLite-specific configuration. Only applies when the SQLite backend
   * is active (`disableSqlite` is not `true`).
   */
  sqlite?: TelemetrySqliteOptions;
}

/**
 * Minimal logger interface for telemetry internals.
 *
 * Accepts the same signature as pino's `warn(bindings, message)` so we
 * can pass `ctx.logger` directly without coupling to pino types.
 */
export interface TelemetryLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

/**
 * A telemetry event record persisted to the SQLite `events` table.
 */
export interface TelemetryEvent {
  /** Auto-incremented primary key */
  id?: number;
  /** ISO 8601 timestamp from the event payload */
  timestamp: string;
  /** Context ID from the event payload */
  contextId: string;
  /** Full event name (e.g. "route:myRoute:exchange:started") */
  eventName: string;
  /** JSON-serialized event details */
  details: string;
  /** Exchange ID extracted from payload details (nullable for non-exchange events) */
  exchangeId?: string;
  /** Correlation ID extracted from payload details (nullable for non-exchange events) */
  correlationId?: string;
}
