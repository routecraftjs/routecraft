import {
  type Source,
  type ExchangeHeaders,
  type Destination,
  type Processor,
  type Exchange,
  CraftContext,
} from "@routecraftjs/routecraft";

/**
 * Adapter for Next.js API routes.
 *
 * This adapter is used to handle incoming requests from Next.js API routes.
 * It is used to convert the incoming request into a Routecraft exchange and
 * then pass it to the next operation in the route.
 */
export class ApiAdapter<T = unknown>
  implements Source<T>, Destination<T>, Processor<T>
{
  readonly adapterId = "routecraft.nextjs.adapter.api";
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
