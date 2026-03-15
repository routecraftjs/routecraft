/**
 * Configuration options for the telemetry plugin.
 */
export interface TelemetryOptions {
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

  /**
   * Maximum number of events to buffer before flushing to the database.
   * Events are written asynchronously in batches for performance.
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
