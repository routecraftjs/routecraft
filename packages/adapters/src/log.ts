import {
  type Destination,
  type Exchange,
  type Processor,
} from "@routecraft/core";

export class LogAdapter implements Destination, Processor {
  readonly adapterId = "routecraft.adapter.log";

  send(exchange: Exchange): Promise<void> {
    exchange.logger.info("Logging Exchange", this.baseExchange(exchange));
    return Promise.resolve();
  }

  process(exchange: Exchange): Promise<Exchange> {
    exchange.logger.info("Logging Exchange", this.baseExchange(exchange));
    return Promise.resolve(exchange);
  }

  private baseExchange(exchange: Exchange): Partial<Exchange> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
