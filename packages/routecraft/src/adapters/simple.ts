import { type Source } from "../operations/from";
import { type Exchange, type ExchangeHeaders } from "../exchange";
import { CraftContext } from "../context";

/**
 * Create a simple adapter that produces static or dynamically generated data.
 *
 * This adapter can be used as a source in a route to provide data.
 *
 * @template T The type of data to produce
 * @param producer A static value or function that produces a value
 * @returns A SimpleAdapter instance
 */
export function simple<T = unknown>(
  producer: (() => T | Promise<T>) | T,
): SimpleAdapter<T> {
  return new SimpleAdapter<T>(
    typeof producer === "function"
      ? (producer as () => T | Promise<T>)
      : () => producer,
  );
}

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
