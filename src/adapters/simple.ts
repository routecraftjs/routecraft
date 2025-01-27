import {
  type CraftContext,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/core";

export class SimpleSource implements Source {
  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    _context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => void,
  ): Promise<() => void> {
    const result = await this.producer();

    if (Array.isArray(result)) {
      for (const item of result) {
        await Promise.resolve(handler(item));
      }
    } else {
      await Promise.resolve(
        handler(result),
      );
    }

    return () => {};
  }
}
