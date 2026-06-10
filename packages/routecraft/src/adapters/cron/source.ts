import type { Cron as CronType } from "croner";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange";
import { type Source, type Subscription } from "../../operations/from";
import { type CraftContext, type MergedOptions } from "../../context";
import { loadOptionalPeer } from "../shared/optional-peer";
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

  /**
   * Loader for the `croner` driver. Exposed as a static so tests can
   * substitute a synchronous implementation and avoid the dynamic-import
   * + fake-timer interaction (Node's dynamic import internals lean on
   * `setImmediate`, which `vi.useFakeTimers()` mocks).
   * @internal
   */
  static loadDriver: () => Promise<typeof CronType> = () =>
    loadOptionalPeer(() => import("croner"), {
      adapterName: "cron",
      packageName: "croner",
    }).then((m) => m.Cron);

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
   * when the job is stopped (via abort, maxFires, or handler error),
   * and rejects if croner is missing or the expression is invalid.
   *
   * @param sub - Subscription handle. `sub.context` provides logging and
   *   merged options; `sub.emit` is called with `undefined` body and cron
   *   headers on each fire; `sub.signal` stops the cron job. `sub.ready()`
   *   fires once the job is scheduled, after the lazy `croner` import
   *   resolves on first use, so on a cold start it lands one or more
   *   microtasks after `subscribe()` returns rather than synchronously.
   *   Consumers of `route:started` see the same delay.
   */
  subscribe(sub: Subscription<undefined>): Promise<void> {
    const context = sub.context;
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
    if (sub.signal.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let counter = 0;
      let settled = false;
      let job: CronType | null = null;

      const settle = () => {
        if (settled) return;
        settled = true;
        job?.stop();
        resolve();
      };

      // Register the abort listener synchronously so an abort that arrives
      // before the dynamic croner import resolves still tears the source down.
      sub.signal.addEventListener("abort", () => settle());

      // croner is declared as an optional peer dep; load it lazily so
      // routes that never use cron() do not require the package.
      void (async () => {
        let Cron: typeof CronType;
        try {
          Cron = await CronSourceAdapter.loadDriver();
        } catch (err) {
          reject(err);
          return;
        }
        if (settled) return;

        // Wrap synchronous setup (`new Cron`, `onReady`) so a throw from
        // croner (e.g. invalid expression) rejects the outer promise
        // instead of leaking as an unhandled rejection.
        try {
          job = new Cron(
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
              if (settled || sub.signal.aborted) {
                settle();
                return;
              }

              counter++;
              const firedTime = new Date();

              // Apply jitter delay before firing (blocking, not fire-and-forget)
              if (jitterMs > 0) {
                const jitter = Math.floor(Math.random() * jitterMs);
                await new Promise((r) => setTimeout(r, jitter));
                if (sub.signal.aborted) {
                  settle();
                  return;
                }
              }

              const nextDate = job!.nextRun();
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
                await sub.emit({ message: undefined, headers });
              } catch {
                // Exchange error already logged by the route pipeline.
                // Cron jobs are long-running; continue to the next scheduled fire.
              }

              // Settle when croner has exhausted maxRuns
              if (job!.runsLeft() === 0) {
                settle();
              }
            },
          );

          sub.ready();
        } catch (err) {
          reject(err);
        }
      })();
    });
  }
}
