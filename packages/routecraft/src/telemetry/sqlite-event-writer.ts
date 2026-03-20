import type { SqliteConnection } from "./sqlite-connection.ts";
import type { TelemetryEvent, TelemetryLogger } from "./types.ts";

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
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      this.insertManyTxn(batch);
    } catch (err) {
      // Non-blocking: SQLite errors must not destabilize event processing.
      this.logger?.warn(
        { err, batchSize: batch.length },
        "Failed to flush telemetry event batch",
      );
    }
  }

  close(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }
}
