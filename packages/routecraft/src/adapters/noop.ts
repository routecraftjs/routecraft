import {
  type CraftContext,
  type Destination,
  type Exchange,
  type ExchangeHeaders,
  type Processor,
  type Source,
} from "routecraft";

export class NoopAdapter<T = unknown>
  implements Source<T>, Destination<T>, Processor<T>
{
  readonly adapterId = "routecraft.adapter.noop";
  subscribe(
    context: CraftContext,
    _handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    context.logger.debug("Aborting subscription immediately");
    abortController.abort();
    return Promise.resolve();
  }

  send(exchange: Exchange<T>): Promise<void> {
    exchange.logger.info("Discarding message", { id: exchange.id });
    return Promise.resolve();
  }

  process(exchange: Exchange<T>): Promise<Exchange<T>> {
    exchange.logger.info("Passing through exchange", { id: exchange.id });
    return Promise.resolve(exchange);
  }
}
