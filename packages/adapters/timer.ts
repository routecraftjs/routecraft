import {
  type CraftContext,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/core";

declare module "@routecraft/core" {
  interface RouteCraftHeaders {
    [TimerHeadersKeys.TIMER_TIME]?: string;
    [TimerHeadersKeys.TIMER_FIRED_TIME]?: string;
    [TimerHeadersKeys.TIMER_PERIOD_MS]?: number;
    [TimerHeadersKeys.TIMER_COUNTER]?: number;
    [TimerHeadersKeys.TIMER_NEXT_RUN]?: string;
  }
}

export enum TimerHeadersKeys {
  /** The exact timestamp when the timer fired. ISO 8601 format   */
  TIMER_TIME = "routecraft.timer.time",
  /**The timestamp when the exchange was created. ISO 8601 format */
  TIMER_FIRED_TIME = "routecraft.timer.firedTime",
  /** The period in milliseconds between timer firings */
  TIMER_PERIOD_MS = "routecraft.timer.periodMs",
  /** The number of times the timer has fired */
  TIMER_COUNTER = "routecraft.timer.counter",
  /** The next timestamp when the timer will fire. ISO 8601 format */
  TIMER_NEXT_RUN = "routecraft.timer.nextRun",
}

export interface TimerOptions {
  /**
   * Time between executions in milliseconds
   * @default 1000
   */
  intervalMs?: number;

  /**
   * Delay before the first execution in milliseconds
   * @default 0
   */
  delayMs?: number;

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
   * Executes at an exact time of day (ISO HH:mm:ss)
   * @default null
   */
  exactTime?: string;

  /**
   * Allows custom date formats for execution times
   * @default null
   */
  timePattern?: string;

  /**
   * Adds random delay to prevent synchronized execution spikes
   * @default 0
   */
  jitterMs?: number;
}

export class TimerAdapter implements Source {
  readonly adapterId = "routecraft.adapter.timer";
  constructor(private options?: TimerOptions) {}

  subscribe(
    _context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    const {
      intervalMs = 1000,
      delayMs = 0,
      repeatCount = Infinity,
      fixedRate = false,
      exactTime,
      jitterMs = 0,
    } = this.options || {};

    // Determine the start time
    let baseTime: number;
    if (exactTime) {
      // exactTime should be in the format "HH:mm:ss"
      const now = new Date();
      const [hour, minute, second] = exactTime.split(":").map(Number);
      // Create a Date for today with the provided exact time
      const scheduled = new Date(now);
      scheduled.setHours(hour, minute, second, 0);
      // If the scheduled time already passed today, schedule for tomorrow
      if (scheduled.getTime() <= now.getTime()) {
        scheduled.setDate(scheduled.getDate() + 1);
      }
      baseTime = scheduled.getTime();
    } else {
      baseTime = Date.now() + delayMs;
    }

    // Create and return an async promise that runs the timer loop
    return new Promise<void>((resolve) => {
      let count = 0;

      const runTimer = async () => {
        while (count < repeatCount && !abortController.signal.aborted) {
          let scheduledTime: number;
          if (fixedRate) {
            if (exactTime) {
              // For exact time scheduling with fixedRate, fire once per day.
              scheduledTime = baseTime + count * 24 * 60 * 60 * 1000;
            } else {
              scheduledTime = baseTime + count * intervalMs;
            }
          } else {
            // Non-fixedRate: the first run uses baseTime; subsequent runs trigger delay after the previous run.
            if (count === 0) {
              scheduledTime = baseTime;
            } else {
              scheduledTime = Date.now() + intervalMs;
            }
          }

          // Calculate waiting time until scheduled execution
          const now = Date.now();
          let waitTime = scheduledTime - now;
          if (waitTime < 0) {
            waitTime = 0;
          }
          if (jitterMs > 0) {
            const jitter = Math.floor(Math.random() * jitterMs);
            waitTime += jitter;
          }

          await new Promise((r) => setTimeout(r, waitTime));
          if (abortController.signal.aborted) break;

          const firedTime = new Date();
          count++;

          // Compute the next scheduled time for header information
          let nextScheduledTime: number;
          if (fixedRate) {
            if (exactTime) {
              nextScheduledTime = baseTime + count * 24 * 60 * 60 * 1000;
            } else {
              nextScheduledTime = baseTime + count * intervalMs;
            }
          } else {
            nextScheduledTime = Date.now() + intervalMs;
          }

          // Prepare timer-based headers
          const headers: ExchangeHeaders = {
            [TimerHeadersKeys.TIMER_TIME]: firedTime.toISOString(),
            [TimerHeadersKeys.TIMER_FIRED_TIME]: firedTime.toISOString(),
            [TimerHeadersKeys.TIMER_PERIOD_MS]: exactTime
              ? 24 * 60 * 60 * 1000
              : intervalMs,
            [TimerHeadersKeys.TIMER_COUNTER]: count,
            [TimerHeadersKeys.TIMER_NEXT_RUN]: new Date(
              nextScheduledTime,
            ).toISOString(),
          };

          // Trigger the handler for this timer tick.
          await handler(null, headers);
        }
        resolve();
      };

      runTimer();
    });
  }
}
