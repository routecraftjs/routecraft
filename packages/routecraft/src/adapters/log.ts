import { type Destination } from "../operations/to";
import { type Tap } from "../operations/tap";
import { type Exchange } from "../exchange";

/** Pino-compatible log levels for LogAdapter. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Options for LogAdapter. */
export interface LogAdapterOptions {
  /** Log level to use (default: "info"). */
  level?: LogLevel;
}

const DEFAULT_LEVEL: LogLevel = "info";

export class LogAdapter<T = unknown> implements Destination<T>, Tap<T> {
  readonly adapterId = "routecraft.adapter.log";

  private readonly level: LogLevel;
  private readonly formatter: ((exchange: Exchange<T>) => unknown) | undefined;

  constructor(
    formatter?: (exchange: Exchange<T>) => unknown,
    options?: LogAdapterOptions,
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

  tap(exchange: Exchange<T>): Promise<void> {
    const logData = this.formatter
      ? this.formatter(exchange)
      : this.baseExchange(exchange);
    exchange.logger[this.level](logData, "LogAdapter tap");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
