import {
  type CraftContext,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/core";

export class SimpleAdapter implements Source {
  readonly adapterId = "routecraft.adapter.simple";

  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    _context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    console.info("Producing messages");
    let result;
    try {
      result = await this.producer();
    } catch (error) {
      console.error("Failed to produce messages", error);
      abortController.abort();
      throw error;
    }

    if (Array.isArray(result)) {
      console.debug(`Processing array of ${result.length} messages`);
      try {
        await Promise.all(
          result.map((item) =>
            handler(item).catch((error) => {
              console.error("Failed to process message", { error });
              throw error;
            }),
          ),
        );
      } finally {
        console.debug("Finished processing array of messages");
        abortController.abort();
      }
    } else {
      console.debug("Processing single message");
      try {
        await handler(result);
      } catch (error) {
        console.error("Failed to process message", { error });
        throw error;
      } finally {
        console.debug("Finished processing single message");
        abortController.abort();
      }
    }
  }
}
