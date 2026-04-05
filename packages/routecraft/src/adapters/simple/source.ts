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
      try {
        await Promise.all(result.map((item) => handler(item).catch(() => {})));
      } finally {
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
        // Exchange error already logged and emitted by the route pipeline.
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
