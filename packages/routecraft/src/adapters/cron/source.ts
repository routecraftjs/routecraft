import { Cron } from "croner";
import {
  HeadersKeys,
  type Exchange,
  type ExchangeHeaders,
} from "../../exchange";
import { type Source } from "../../operations/from";
import { type CraftContext, type MergedOptions } from "../../context";
import type { CronExpression, CronOptions } from "./types";

/**
 * Store key for merged cron adapter options.
 * Set context-level defaults (e.g., jitterMs) once and share across all
 * cron sources in the same context.
 * @internal
 */
export const ADAPTER_CRON_OPTIONS = Symbol.for(
  "routecraft.adapter.cron.options",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_CRON_OPTIONS]: Partial<CronOptions>;
  }
}

/**
 * Source adapter that fires on a cron schedule using the `croner` library.
 *
 * Body is always `undefined`; scheduling metadata is provided via
 * `routecraft.cron.*` exchange headers (expression, firedTime, nextRun,
 * counter, timezone, name).
 *
 * Supports standard 5-field cron (minute granularity), extended 6-field
 * (second granularity), and nicknames (`@daily`, `@hourly`, etc.).
 *
 * Options can be set per-adapter or globally via `CraftContext` store
 * using the `ADAPTER_CRON_OPTIONS` key. Per-adapter options take precedence.
 */
export class CronSourceAdapter
  implements Source<undefined>, MergedOptions<CronOptions>
{
  readonly adapterId = "routecraft.adapter.cron";
  public options: Partial<CronOptions>;

  constructor(
    private readonly expression: CronExpression,
    options?: CronOptions,
  ) {
    this.options = options ?? {};
  }

  /**
   * Merge adapter-level options with context-level options.
   * Per-adapter values take precedence over context-level defaults.
   *
   * @param context - The CraftContext
   * @returns Merged options
   */
  mergedOptions(context: CraftContext): CronOptions {
    const contextOptions =
      (context.getStore(ADAPTER_CRON_OPTIONS) as
        | Partial<CronOptions>
        | undefined) ?? {};
    return {
      ...contextOptions,
      ...this.options,
    };
  }

  /**
   * Subscribe to cron-scheduled triggers.
   *
   * Creates a `croner` job from the configured expression and invokes
   * the handler on each scheduled fire. The returned promise resolves
   * when the job is stopped (via abort, maxFires, or handler error).
   *
   * @param context - CraftContext for logging and merged options
   * @param handler - Called with `undefined` body and cron headers on each fire
   * @param abortController - Abort signal to stop the cron job
   * @param onReady - Called once the job is scheduled and ready
   */
  subscribe(
    context: CraftContext,
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
      protect = true,
      startAt,
      stopAt,
    } = this.mergedOptions(context);

    if (Number.isNaN(maxFires) || maxFires < 0) {
      throw new Error("cron maxFires must be a non-negative number");
    }
    if (Number.isNaN(jitterMs) || jitterMs < 0) {
      throw new Error("cron jitterMs must be a non-negative number");
    }

    // Resolve immediately if already aborted (avoids hanging when
    // startAt/stopAt postpone the first tick indefinitely).
    if (abortController.signal.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let counter = 0;
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        job.stop();
        resolve();
      };

      const job = new Cron(
        this.expression,
        {
          ...(timezone ? { timezone } : {}),
          protect,
          ...(maxFires !== Infinity ? { maxRuns: maxFires } : {}),
          ...(startAt ? { startAt } : {}),
          ...(stopAt ? { stopAt } : {}),
          paused: false,
        },
        async () => {
          if (settled || abortController.signal.aborted) {
            settle();
            return;
          }

          counter++;
          const firedTime = new Date();

          // Apply jitter delay before firing (blocking, not fire-and-forget)
          if (jitterMs > 0) {
            const jitter = Math.floor(Math.random() * jitterMs);
            await new Promise((r) => setTimeout(r, jitter));
            if (abortController.signal.aborted) {
              settle();
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
            context.logger.error({ adapter: "cron", err: error }, msg);
            abortController.abort();
            settle();
            return;
          }

          // Settle when croner has exhausted maxRuns
          if (job.runsLeft() === 0) {
            settle();
          }
        },
      );

      abortController.signal.addEventListener("abort", () => settle());

      onReady?.();
    });
  }
}
