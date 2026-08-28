import type { Duration } from "../../shared/duration.ts";

export interface TimerOptions {
  /**
   * Time between executions.
   * @default 1000
   */
  interval?: Duration;

  /**
   * Delay before the first execution.
   * @default 0
   */
  delay?: Duration;

  /**
   * Number of times to trigger before stopping
   * @default Infinity
   */
  repeatCount?: number;

  /**
   * Ensures execution happens at exact intervals (ignoring execution time)
   * @default false
   */
  fixedRate?: boolean;

  /**
   * Upper bound on a random delay added to each scheduled run, to stop many
   * instances firing in lockstep. Each wait is drawn uniformly from
   * `[0, maxJitter)`.
   * @default 0
   */
  maxJitter?: Duration;
}

/**
 * Header keys the timer source sets on every emitted exchange. Keys live
 * under the reserved `routecraft.timer.*` namespace; the value types are
 * merged into `RoutecraftHeaders` below.
 */
export const TimerHeaders = {
  /** The exact timestamp when the timer fired, in ISO 8601 format */
  TIME: "routecraft.timer.time",
  /** The timestamp when the exchange was created, in ISO 8601 format */
  FIRED_TIME: "routecraft.timer.firedTime",
  /** The period in milliseconds between timer firings */
  PERIOD_MS: "routecraft.timer.periodMs",
  /** The number of times the timer has fired */
  COUNTER: "routecraft.timer.counter",
  /** The next timestamp when the timer will fire, in ISO 8601 format */
  NEXT_RUN: "routecraft.timer.nextRun",
} as const satisfies Record<string, `routecraft.timer.${string}`>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The exact timestamp when the timer fired, in ISO 8601 format */
    [TimerHeaders.TIME]?: string;
    /** The timestamp when the exchange was created, in ISO 8601 format */
    [TimerHeaders.FIRED_TIME]?: string;
    /** The period in milliseconds between timer firings */
    [TimerHeaders.PERIOD_MS]?: number;
    /** The number of times the timer has fired */
    [TimerHeaders.COUNTER]?: number;
    /** The next timestamp when the timer will fire, in ISO 8601 format */
    [TimerHeaders.NEXT_RUN]?: string;
  }
}
