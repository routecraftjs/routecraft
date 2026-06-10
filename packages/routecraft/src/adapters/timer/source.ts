import { HeadersKeys, type ExchangeHeaders } from "../../exchange";
import { type Source, type Subscription } from "../../operations/from";
import type { TimerOptions } from "./types";

export class TimerSourceAdapter implements Source<undefined> {
  readonly adapterId = "routecraft.adapter.timer";
  constructor(private options?: TimerOptions) {}

  subscribe(sub: Subscription<undefined>): Promise<void> {
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

    sub.ready();

    // Create and return an async promise that runs the timer loop
    return new Promise<void>((resolve) => {
      let count = 0;

      const runTimer = async () => {
        while (count < repeatCount && !sub.signal.aborted) {
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

          // Abort-aware wait: a plain setTimeout would pin shutdown for up
          // to one full interval after the route stops.
          await new Promise<void>((r) => {
            const onAbort = () => {
              clearTimeout(t);
              r();
            };
            const t = setTimeout(() => {
              sub.signal.removeEventListener("abort", onAbort);
              r();
            }, waitTime);
            sub.signal.addEventListener("abort", onAbort, { once: true });
          });
          if (sub.signal.aborted) break;

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
            [HeadersKeys.TIMER_TIME]: firedTime.toISOString(),
            [HeadersKeys.TIMER_FIRED_TIME]: firedTime.toISOString(),
            [HeadersKeys.TIMER_PERIOD_MS]: exactTime
              ? 24 * 60 * 60 * 1000
              : intervalMs,
            [HeadersKeys.TIMER_COUNTER]: count,
            [HeadersKeys.TIMER_NEXT_RUN]: new Date(
              nextScheduledTime,
            ).toISOString(),
          };

          try {
            await sub.emit({ message: undefined, headers });
          } catch {
            // Exchange error already logged by the route pipeline.
            // Timer continues to fire for remaining ticks.
          }
        }
        resolve();
      };

      runTimer();
    });
  }
}
