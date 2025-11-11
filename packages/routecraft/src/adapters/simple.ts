import { type Source } from "../operations/from";
import { type Exchange, type ExchangeHeaders } from "../exchange";
import { CraftContext } from "../context";

export class SimpleAdapter<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.simple";

  constructor(private producer: () => T | Promise<T>) {}

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    context.logger.debug("Producing messages");
    let result;
    try {
      result = await this.producer();
    } catch (error) {
      context.logger.error(error, "Failed to produce messages");
      abortController.abort();
      throw error;
    }

    if (Array.isArray(result)) {
      context.logger.debug(`Processing array of ${result.length} messages`);
      try {
        await Promise.all(
          result.map((item) =>
            handler(item).catch((error) => {
              context.logger.error(error, "Failed to process message");
              throw error;
            }),
          ),
        );
      } finally {
        context.logger.debug("Finished processing array of messages");
        abortController.abort();
      }
    } else {
      context.logger.debug("Processing single message");
      try {
        await handler(result);
      } catch (error) {
        context.logger.error(error, "Failed to process message");
        throw error;
      } finally {
        context.logger.debug("Finished processing single message");
        abortController.abort();
      }
    }
  }
}
