import type { Destination } from "../../operations/to";
import type { Exchange } from "../../exchange";
import { LogDestinationAdapter } from "./destination";
import type { LogOptions } from "./types";

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
): Destination<T, void> {
  return new LogDestinationAdapter<T>(formatter, options);
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
): Destination<T, void> {
  return new LogDestinationAdapter<T>(formatter, {
    ...options,
    level: "debug",
  });
}

// Re-export adapter class and types for public API
export { LogDestinationAdapter } from "./destination";
export type { LogLevel, LogOptions } from "./types";
