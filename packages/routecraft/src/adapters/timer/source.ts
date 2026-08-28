import type { ExchangeHeaders } from "../../exchange";
import { TimerHeaders } from "./types";
import type { Source, Subscription } from "../../operations/from";
import type { TimerOptions } from "./types";
import { parseDuration } from "../../shared/duration.ts";

export class TimerSourceAdapter implements Source<undefined> {
  readonly adapterId = "routecraft.adapter.timer";
  constructor(private options?: TimerOptions) {}

  subscribe(sub: Subscription<undefined>): Promise<void> {
    const {
      interval = 1000,
      delay = 0,
      repeatCount = Infinity,
      fixedRate = false,
      maxJitter = 0,
    } = this.options || {};
    const intervalMs = parseDuration(interval, "timer({ interval })");
    const delayMs = parseDuration(delay, "timer({ delay })", 0);
    const maxJitterMs = parseDuration(maxJitter, "timer({ maxJitter })", 0);

    const baseTime = Date.now() + delayMs;

    sub.ready();

    // Create and return an async promise that runs the timer loop
    return new Promise<void>((resolve) => {
      let count = 0;

      const runTimer = async () => {
        while (count < repeatCount && !sub.signal.aborted) {
          let scheduledTime: number;
          if (fixedRate) {
            scheduledTime = baseTime + count * intervalMs;
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
          if (maxJitterMs > 0) {
            // Uniform in [0, maxJitter): the option is an upper bound, which
            // is what its name promises.
            waitTime += Math.floor(Math.random() * maxJitterMs);
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
          const nextScheduledTime = fixedRate
            ? baseTime + count * intervalMs
            : Date.now() + intervalMs;

          // Prepare timer-based headers
          const headers: ExchangeHeaders = {
            [TimerHeaders.TIME]: firedTime.toISOString(),
            [TimerHeaders.FIRED_TIME]: firedTime.toISOString(),
            [TimerHeaders.PERIOD_MS]: intervalMs,
            [TimerHeaders.COUNTER]: count,
            [TimerHeaders.NEXT_RUN]: new Date(nextScheduledTime).toISOString(),
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
