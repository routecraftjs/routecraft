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
    onReady?: () => void,
  ): Promise<void> {
    onReady?.();
    context.logger.debug({ adapter: "simple" }, "Producing messages");
    let result;
    try {
      result = await this.producer();
    } catch (error) {
      abortController.abort();
      throw error;
    }

    if (Array.isArray(result)) {
      context.logger.debug(
        { adapter: "simple", messageCount: result.length },
        "Processing array of messages",
      );
      try {
        await Promise.all(result.map((item) => handler(item)));
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
