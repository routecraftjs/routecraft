import { type Source } from "../../operations/from";
import { type Exchange, type ExchangeHeaders } from "../../exchange";
import { CraftContext } from "../../context";

export class SimpleSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.simple";

  constructor(private producer: () => T | Promise<T>) {}

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    onReady?.();
    context.logger.debug({ adapter: "simple" }, "Producing messages");
    let result;
    try {
      result = await this.producer();
    } catch (error) {
      context.logger.error(
        { adapter: "simple", err: error },
        "Producer failed; aborting",
      );
      abortController.abort();
      throw error;
    }

    if (Array.isArray(result)) {
      context.logger.debug(
        { adapter: "simple", messageCount: result.length },
        "Processing array of messages",
      );
      let failCount = 0;
      try {
        await Promise.all(
          result.map((item) =>
            handler(item).catch(() => {
              // Exchange error already logged by the route pipeline.
              failCount++;
            }),
          ),
        );
      } finally {
        if (failCount > 0) {
          context.logger.warn(
            { adapter: "simple", failCount, total: result.length },
            "Some exchanges in batch failed",
          );
        }
        context.logger.debug(
          { adapter: "simple" },
          "Finished processing array of messages",
        );
        abortController.abort();
      }
    } else {
      context.logger.debug({ adapter: "simple" }, "Processing single message");
      try {
        await handler(result);
      } catch {
        // Exchange error already logged by the route pipeline.
        // SimpleSource does not re-throw: the route already emitted
        // context:error, and re-throwing would cause a duplicate emission.
      } finally {
        context.logger.debug(
          { adapter: "simple" },
          "Finished processing single message",
        );
        abortController.abort();
      }
    }
  }
}
