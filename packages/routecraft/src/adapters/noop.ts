import { type Source } from "../operations/from";
import { type ExchangeHeaders } from "../exchange";
import { type Destination } from "../operations/to";
import { type Processor } from "../operations/process";
import { type Exchange } from "../exchange";
import { CraftContext } from "../context";

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
