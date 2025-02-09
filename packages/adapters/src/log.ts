import {
  type Destination,
  type Exchange,
  type Processor,
} from "@routecraft/core";

export class LogAdapter<T = unknown> implements Destination<T>, Processor<T> {
  readonly adapterId = "routecraft.adapter.log";

  send(exchange: Exchange<T>): Promise<void> {
    exchange.logger.info(this.baseExchange(exchange), "Logging Exchange");
    return Promise.resolve();
  }

  process(exchange: Exchange<T>): Promise<Exchange<T>> {
    exchange.logger.info(this.baseExchange(exchange), "Logging Exchange");
    return Promise.resolve(exchange);
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
