import { type Destination } from "../operations/to";
import { type Exchange } from "../exchange";

/** Pino-compatible log levels for LogAdapter. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Options for LogAdapter. */
export interface LogOptions {
  /** Log level to use (default: "info"). */
  level?: LogLevel;
}

const DEFAULT_LEVEL: LogLevel = "info";

export class LogAdapter<T = unknown> implements Destination<T, void> {
  readonly adapterId = "routecraft.adapter.log";

  private readonly level: LogLevel;
  private readonly formatter: ((exchange: Exchange<T>) => unknown) | undefined;

  constructor(
    formatter?: (exchange: Exchange<T>) => unknown,
    options?: LogOptions,
  ) {
    this.formatter = formatter;
    this.level = options?.level ?? DEFAULT_LEVEL;
  }

  send(exchange: Exchange<T>): Promise<void> {
    const logData = this.formatter
      ? this.formatter(exchange)
      : this.baseExchange(exchange);
    exchange.logger[this.level](logData, "LogAdapter output");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}

/**
 * Create a logging adapter that logs messages to the console.
 *
 * @template T The type of data this adapter processes
 * @param formatter Optional function that takes an exchange and returns the value to log.
 * @param options Optional configuration object with `level` (defaults to "info").
 * @returns A LogAdapter instance
 */
export function log<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: LogOptions,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, options);
}

/**
 * Create a logging adapter that logs at DEBUG level.
 *
 * @template T The type of data this adapter processes
 * @param formatter Optional function that takes an exchange and returns the value to log
 * @param options Optional configuration (level is fixed to "debug")
 * @returns A LogAdapter instance
 */
export function debug<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: Omit<LogOptions, "level">,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, { ...options, level: "debug" });
}
