import {
  type CraftContext,
  type Destination,
  type Exchange,
  type ExchangeHeaders,
  type Processor,
  type Source,
} from "@routecraft/core";

export class NoopAdapter implements Source, Destination, Processor {
  subscribe(
    _context: CraftContext,
    _handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    abortController.abort();
    return Promise.resolve();
  }
  async send(_exchange: Exchange): Promise<void> {}
  process(exchange: Exchange): Promise<Exchange> {
    return Promise.resolve(exchange);
  }
}
