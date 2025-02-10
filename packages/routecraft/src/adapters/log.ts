import {
  type Destination,
  type Exchange,
  type Processor,
  type Tap,
} from "routecraft";

export class LogAdapter<T = unknown>
  implements Destination<T>, Processor<T>, Tap<T>
{
  readonly adapterId = "routecraft.adapter.log";

  send(exchange: Exchange<T>): Promise<void> {
    exchange.logger.info(this.baseExchange(exchange), "Logging Exchange");
    return Promise.resolve();
  }

  process(exchange: Exchange<T>): Promise<Exchange<T>> {
    exchange.logger.info(this.baseExchange(exchange), "Logging Exchange");
    return Promise.resolve(exchange);
  }

  tap(exchange: Exchange<T>): Promise<void> {
    exchange.logger.info(this.baseExchange(exchange), "Logging Exchange");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
