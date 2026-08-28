import type { Source } from "../../operations/from";
import { TimerSourceAdapter } from "./source";
import type { TimerOptions } from "./types";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";

/**
 * Creates a source that emits at a fixed interval. Body is undefined; timer
 * metadata is in exchange headers (routecraft.timer.*).
 *
 * For a wall-clock schedule ("every weekday at 09:00") use `cron()`, which
 * supports timezones.
 *
 * @param options - interval, delay, repeatCount, fixedRate, maxJitter
 * @returns A Source usable with `.from(timer(options))`
 *
 * @example
 * ```typescript
 * .from(timer({ interval: "5s", repeatCount: 10 }))
 * .from(timer({ interval: "1m", maxJitter: "5s" }))
 * ```
 */
export function timer(options?: TimerOptions): Source<undefined> {
  return tagAdapter(
    new TimerSourceAdapter(options),
    timer,
    factoryArgs(options),
  );
}

// Re-export adapter class and types for public API
export { TimerSourceAdapter } from "./source";
export type { TimerOptions } from "./types";
export { TimerHeaders } from "./types";
