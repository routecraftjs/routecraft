import { type Destination } from "../operations/to";
import { type Tap } from "../operations/tap";
import { type Exchange } from "../exchange";

export class LogAdapter<T = unknown> implements Destination<T>, Tap<T> {
  readonly adapterId = "routecraft.adapter.log";

  constructor(
    private readonly formatter?: (exchange: Exchange<T>) => unknown,
  ) {}

  send(exchange: Exchange<T>): Promise<void> {
    const logData = this.formatter
      ? this.formatter(exchange)
      : this.baseExchange(exchange);
    exchange.logger.info(logData, "LogAdapter output");
    return Promise.resolve();
  }

  tap(exchange: Exchange<T>): Promise<void> {
    const logData = this.formatter
      ? this.formatter(exchange)
      : this.baseExchange(exchange);
    exchange.logger.info(logData, "LogAdapter tap");
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
