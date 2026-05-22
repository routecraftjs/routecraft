import type { Source } from "../../operations/from";
import { TimerSourceAdapter } from "./source";
import type { TimerOptions } from "./types";

/**
 * Creates a source that emits at a fixed interval (or at exact times). Body is undefined; timer metadata is in exchange headers (routecraft.timer.*).
 *
 * @param options - intervalMs, delayMs, repeatCount, fixedRate, exactTime, timePattern, jitterMs
 * @returns A Source usable with `.from(timer(options))`
 *
 * @example
 * ```typescript
 * .from(timer({ intervalMs: 5000, repeatCount: 10 }))
 * .from(timer({ exactTime: '09:00:00' }))
 * ```
 */
export function timer(options?: TimerOptions): Source<undefined> {
  return new TimerSourceAdapter(options);
}

// Re-export adapter class and types for public API
export { TimerSourceAdapter } from "./source";
export type { TimerOptions } from "./types";
