import type { SqliteConnection } from "./sqlite-connection.ts";
import type { TelemetryEvent, TelemetryLogger } from "./types.ts";

/**
 * Upper bound on events retained in memory while flushes keep failing. A
 * transient fault is retried without loss; a sustained outage drops the
 * oldest events past this cap so the sink can never OOM the host process.
 */
const MAX_BUFFERED_EVENTS = 10_000;

/**
 * Buffered batch writer for the SQLite `events` table.
 *
 * Accumulates events in memory and flushes them in batches
 * (by size threshold or time interval) for performance.
 *
 * This is a SQLite-specific materialized view of the raw event stream.
 * External backends derive the same view from trace data.
 */
export class SqliteEventWriter {
  private readonly logger: TelemetryLogger | undefined;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly insertStmt: { run(...params: unknown[]): unknown };
  private readonly insertManyTxn: (events: TelemetryEvent[]) => void;
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    connection: SqliteConnection,
    batchSize: number,
    flushIntervalMs: number,
  ) {
    this.logger = connection.logger;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;

    this.insertStmt = connection.db.prepare(
      "INSERT INTO events (timestamp, context_id, event_name, details, exchange_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
    );

    this.insertManyTxn = connection.db.transaction(
      (events: TelemetryEvent[]) => {
        for (const event of events) {
          this.insertStmt.run(
            event.timestamp,
            event.contextId,
            event.eventName,
            event.details,
            event.exchangeId ?? null,
            event.correlationId ?? null,
          );
        }
      },
    );

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

  write(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    // Snapshot without removing: a failed transaction must leave the events
    // buffered so a transient fault (locked DB, brief I/O error) is retried on
    // the next flush instead of silently dropping telemetry.
    const batch = this.buffer.slice();
    try {
      this.insertManyTxn(batch);
    } catch (err) {
      // Non-blocking: SQLite errors must not destabilize event processing.
      // Keep the batch buffered for retry, but bound the buffer so a sustained
      // outage cannot grow it without limit and OOM the host process. Past the
      // cap, drop the oldest overflow (the freshest events are most useful).
      this.logger?.warn(
        { err, batchSize: batch.length },
        "Failed to flush telemetry event batch; retaining for retry",
      );
      if (this.buffer.length > MAX_BUFFERED_EVENTS) {
        const dropped = this.buffer.length - MAX_BUFFERED_EVENTS;
        this.buffer.splice(0, dropped);
        this.logger?.warn(
          { dropped },
          "Telemetry buffer exceeded cap during sustained sink failure; dropped oldest events",
        );
      }
      return;
    }
    // Commit succeeded: drop exactly the events we persisted. flush() is
    // synchronous (bun:sqlite transactions run sync), so no write() interleaved
    // and the first batch.length entries are exactly the committed ones.
    this.buffer.splice(0, batch.length);
  }

  close(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }
}
