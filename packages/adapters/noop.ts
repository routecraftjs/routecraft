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
    console.debug("Aborting subscription immediately");
    abortController.abort();
    return Promise.resolve();
  }

  send(exchange: Exchange): Promise<void> {
    console.debug("Discarding message", { exchangeId: exchange.id });
    return Promise.resolve();
  }

  process(exchange: Exchange): Promise<Exchange> {
    console.debug("Passing through exchange", { exchangeId: exchange.id });
    return Promise.resolve(exchange);
  }
}
