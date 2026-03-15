import { Cron } from "croner";
import {
  HeadersKeys,
  type Exchange,
  type ExchangeHeaders,
} from "../../exchange";
import { type Source } from "../../operations/from";
import { CraftContext } from "../../context";
import type { CronOptions } from "./types";

/**
 * Source adapter that fires on a cron schedule using the `croner` library.
 *
 * Body is always `undefined`; scheduling metadata is provided via
 * `routecraft.cron.*` exchange headers (expression, firedTime, nextRun,
 * counter, timezone, name).
 *
 * Supports standard 5-field cron (minute granularity), extended 6-field
 * (second granularity), and nicknames (`@daily`, `@hourly`, etc.).
 */
export class CronSourceAdapter implements Source<undefined> {
  readonly adapterId = "routecraft.adapter.cron";

  constructor(
    private readonly expression: string,
    private readonly options?: CronOptions,
  ) {}

  /**
   * Subscribe to cron-scheduled triggers.
   *
   * Creates a `croner` job from the configured expression and invokes
   * the handler on each scheduled fire. The returned promise resolves
   * when the job is stopped (via abort, maxFires, or handler error).
   *
   * @param _context - CraftContext for logging
   * @param handler - Called with `undefined` body and cron headers on each fire
   * @param abortController - Abort signal to stop the cron job
   * @param onReady - Called once the job is scheduled and ready
   */
  subscribe(
    _context: CraftContext,
    handler: (
      message: undefined,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const {
      timezone,
      maxFires = Infinity,
      jitterMs = 0,
      name,
    } = this.options || {};

    return new Promise<void>((resolve) => {
      let counter = 0;

      const job = new Cron(
        this.expression,
        {
          ...(timezone ? { timezone } : {}),
          paused: false,
        },
        async () => {
          if (abortController.signal.aborted) {
            job.stop();
            resolve();
            return;
          }

          counter++;
          if (counter > maxFires) {
            job.stop();
            resolve();
            return;
          }

          const firedTime = new Date();

          // Apply jitter delay before firing (blocking, not fire-and-forget)
          if (jitterMs > 0) {
            const jitter = Math.floor(Math.random() * jitterMs);
            await new Promise((r) => setTimeout(r, jitter));
            if (abortController.signal.aborted) {
              job.stop();
              resolve();
              return;
            }
          }

          const nextDate = job.nextRun();
          const headers: ExchangeHeaders = {
            [HeadersKeys.CRON_EXPRESSION]: this.expression,
            [HeadersKeys.CRON_FIRED_TIME]: firedTime.toISOString(),
            [HeadersKeys.CRON_COUNTER]: counter,
            ...(nextDate
              ? { [HeadersKeys.CRON_NEXT_RUN]: nextDate.toISOString() }
              : {}),
            ...(timezone ? { [HeadersKeys.CRON_TIMEZONE]: timezone } : {}),
            ...(name ? { [HeadersKeys.CRON_NAME]: name } : {}),
          };

          try {
            await handler(undefined, headers);
          } catch (error) {
            const msg =
              error &&
              typeof error === "object" &&
              "meta" in error &&
              typeof (error as { meta: { message?: string } }).meta?.message ===
                "string"
                ? (error as { meta: { message: string } }).meta.message
                : error instanceof Error
                  ? error.message
                  : "Cron handler failed";
            _context.logger.error({ adapter: "cron", err: error }, msg);
            job.stop();
            abortController.abort();
            resolve();
          }
        },
      );

      abortController.signal.addEventListener("abort", () => {
        job.stop();
        resolve();
      });

      onReady?.();
    });
  }
}
