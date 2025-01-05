import { ExchangeHeaders, type Source } from "@routecraft/core";

export class SimpleSource implements Source {
  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    handler: (message: unknown, headers?: ExchangeHeaders) => void,
  ): Promise<() => void> {
    const result = await this.producer();
    await handler(result);
    return () => {};
  }
}
