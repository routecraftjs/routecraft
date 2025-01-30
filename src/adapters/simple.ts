import {
  type CraftContext,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/core";

export class SimpleAdapter implements Source {
  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    _context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    const result = await this.producer();

    if (Array.isArray(result)) {
      await Promise.all(result.map((item) => handler(item))).finally(() => {
        abortController.abort();
      });
    } else {
      await handler(result).finally(() => {
        abortController.abort();
      });
    }
  }
}
