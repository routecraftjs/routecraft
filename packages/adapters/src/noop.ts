import {
  type CraftContext,
  type Destination,
  type Exchange,
  type ExchangeHeaders,
  type Processor,
  type Source,
} from "@routecraft/core";

export class NoopAdapter implements Source, Destination, Processor {
  readonly adapterId = "routecraft.adapter.noop";
  subscribe(
    context: CraftContext,
    _handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    context.logger.debug("Aborting subscription immediately");
    abortController.abort();
    return Promise.resolve();
  }

  send(exchange: Exchange): Promise<void> {
    exchange.logger.info("Discarding message", { id: exchange.id });
    return Promise.resolve();
  }

  process(exchange: Exchange): Promise<Exchange> {
    exchange.logger.info("Passing through exchange", { id: exchange.id });
    return Promise.resolve(exchange);
  }
}
