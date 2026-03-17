import type { TracerProvider } from "@opentelemetry/api";

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
}
