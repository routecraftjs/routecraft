/**
 * Pluggable sink that receives telemetry data from the plugin.
 *
 * Implement this interface to send telemetry to a custom backend
 * (e.g. OpenTelemetry, Datadog, a remote API). The built-in SQLite
 * sink is used when no custom sink is provided.
 *
 * All methods are called synchronously from the plugin's flush loop.
 * If your backend is async, buffer internally and flush in `close()`.
 * Implementations must never throw; errors should be swallowed or logged
 * internally so the running engine is never affected.
 */
export interface TelemetrySink {
  /** Write a batch of raw framework events. */
  writeEvents(events: TelemetryEvent[]): void;
  /** Record a route registration. */
  writeRoute(route: TelemetryRoute): void;
  /** Update a route's status (e.g. "started", "stopped"). */
  updateRouteStatus(routeId: string, contextId: string, status: string): void;
  /** Record a new exchange entering the pipeline. */
  writeExchange(exchange: TelemetryExchange): void;
  /** Mark an exchange as completed. */
  completeExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
  ): void;
  /** Mark an exchange as failed. */
  failExchange(
    exchangeId: string,
    contextId: string,
    completedAt: string,
    durationMs: number,
    error: string,
  ): void;
  /** Flush pending data and release resources. Called during plugin teardown. */
  close(): void | Promise<void>;
}

/**
 * Configuration options for the telemetry plugin.
 */
export interface TelemetryOptions {
  /**
   * Custom sink for telemetry data. When provided, all telemetry is
   * routed to this sink instead of the built-in SQLite sink.
   *
   * @example
   * ```typescript
   * telemetry({ sink: new MyOtelSink() })
   * ```
   */
  sink?: TelemetrySink;

  /**
   * Maximum number of events to buffer before flushing to the sink.
   * Events are written in batches for performance.
   * Defaults to `50`.
   */
  batchSize?: number;

  /**
   * Maximum time in milliseconds to wait before flushing buffered events.
   * Defaults to `1000` (1 second).
   */
  flushIntervalMs?: number;
}

/**
 * Configuration options for the built-in SQLite telemetry sink.
 */
export interface SqliteSinkOptions {
  /**
   * Path to the SQLite database file.
   * Defaults to `.routecraft/telemetry.db` in the current working directory.
   */
  dbPath?: string;

  /**
   * Whether to enable WAL (Write-Ahead Logging) mode for concurrent read/write.
   * Defaults to `true`.
   */
  walMode?: boolean;
}

/**
 * A telemetry event record persisted to SQLite.
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

/**
 * A route record tracked by the telemetry plugin.
 */
export interface TelemetryRoute {
  /** Route ID */
  id: string;
  /** Context ID */
  contextId: string;
  /** ISO 8601 timestamp when the route was registered */
  registeredAt: string;
  /** Current status: registered, started, stopped */
  status: string;
}

/**
 * An exchange record tracked by the telemetry plugin.
 */
export interface TelemetryExchange {
  /** Exchange/correlation ID */
  id: string;
  /** Route ID this exchange belongs to */
  routeId: string;
  /** Context ID */
  contextId: string;
  /** Correlation ID */
  correlationId: string;
  /** Current status: started, completed, failed */
  status: string;
  /** ISO 8601 timestamp when the exchange started */
  startedAt: string;
  /** ISO 8601 timestamp when the exchange completed (null if still running) */
  completedAt: string | null;
  /** Duration in milliseconds (null if still running) */
  durationMs: number | null;
  /** Error message if the exchange failed (null otherwise) */
  error: string | null;
}
