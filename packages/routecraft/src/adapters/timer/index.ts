import type { Source } from "../../operations/from";
import { TimerSourceAdapter } from "./source";
import type { TimerOptions } from "./types";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";
import { rejectStaleOptions } from "../../shared/stale-options.ts";

/** Options removed in 0.7, mapped to what to write instead. */
const REMOVED: Readonly<Record<string, string>> = {
  timePattern:
    "use cron() for a wall-clock schedule, which also has timezones.",
  exactTime:
    "use cron() for a wall-clock schedule, or timer({ delay }) to offset the first run.",
  jitter:
    "use maxJitter, the same value under a name that says it is an upper bound.",
  jitterMs:
    "use maxJitter, the same value under a name that says it is an upper bound.",
};

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
  rejectStaleOptions(options, "timer", REMOVED);
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
