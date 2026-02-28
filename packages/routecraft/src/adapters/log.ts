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
    const adapterLabel = this.adapterId.split(".").pop();
    const bindings =
      typeof logData === "object" && logData !== null
        ? { ...logData, adapter: adapterLabel }
        : { adapter: adapterLabel, value: logData };
    exchange.logger[this.level](bindings, "LogAdapter output");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}

/**
 * Creates a logging destination that logs each exchange (or a formatted value) via the exchange logger.
 *
 * @template T - Body type of the exchange
 * @param formatter - Optional function (exchange) => value to log; default logs id, body, headers
 * @param options - Optional `level` (default "info")
 * @returns A Destination usable with `.to(log())` or `.tap(log())`
 *
 * @example
 * ```typescript
 * .to(log())
 * .to(log((ex) => ({ id: ex.id, body: ex.body })))
 * .to(log(undefined, { level: 'debug' }))
 * ```
 */
export function log<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: LogOptions,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, options);
}

/**
 * Same as `log()` but with level fixed to `"debug"`. Useful for verbose pipelines.
 *
 * @template T - Body type of the exchange
 * @param formatter - Optional (exchange) => value to log
 * @param options - Optional config (level is always "debug")
 * @returns A Destination that logs at debug level
 */
export function debug<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: Omit<LogOptions, "level">,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, { ...options, level: "debug" });
}
