import { type Source } from "../operations/from";
import { type Exchange, type ExchangeHeaders } from "../exchange";
import { CraftContext } from "../context";

/**
 * Creates a source that produces a single value (or one value per call from a function).
 * Use as the first step in a route with `.from(simple(...))`.
 *
 * @template T - Body type produced
 * @param producer - Static value, or function that returns T | Promise<T>
 * @returns A Source usable with `.from(simple(producer))`
 *
 * @example
 * ```typescript
 * .from(simple('hello'))
 * .from(simple(() => fetch('/api/data').then(r => r.json())))
 * ```
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
