import { type Destination } from "../operations/to";
import { type Exchange } from "../exchange";

export class NoopAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = "routecraft.adapter.noop";

  send(exchange: Exchange<T>): Promise<void> {
    exchange.logger.info({ id: exchange.id }, "Discarding message");
    return Promise.resolve();
  }
}
