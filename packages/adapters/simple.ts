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
    const result = await this.producer();

    if (Array.isArray(result)) {
      console.debug(`Processing array of ${result.length} messages`);
      await Promise.all(result.map((item) => handler(item))).finally(() => {
        console.debug("Finished processing array of messages");
        abortController.abort();
      });
    } else {
      console.debug("Processing single message");
      await handler(result).finally(() => {
        console.debug("Finished processing single message");
        abortController.abort();
      });
    }
  }
}
