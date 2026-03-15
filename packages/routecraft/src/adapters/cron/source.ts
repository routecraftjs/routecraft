import { Cron } from "croner";
import {
  HeadersKeys,
  type Exchange,
  type ExchangeHeaders,
} from "../../exchange";
import { type Source } from "../../operations/from";
import { CraftContext } from "../../context";
import type { CronOptions } from "./types";

export class CronSourceAdapter implements Source<undefined> {
  readonly adapterId = "routecraft.adapter.cron";

  constructor(
    private readonly expression: string,
    private readonly options?: CronOptions,
  ) {}

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

          const fireAction = async () => {
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
                typeof (error as { meta: { message?: string } }).meta
                  ?.message === "string"
                  ? (error as { meta: { message: string } }).meta.message
                  : error instanceof Error
                    ? error.message
                    : "Cron handler failed";
              _context.logger.error({ adapter: "cron", err: error }, msg);
              job.stop();
              abortController.abort();
              resolve();
            }
          };

          if (jitterMs > 0) {
            const jitter = Math.floor(Math.random() * jitterMs);
            setTimeout(fireAction, jitter);
          } else {
            await fireAction();
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
