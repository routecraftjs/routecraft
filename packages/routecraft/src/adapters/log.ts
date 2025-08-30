import { type Destination } from "../operations/to";
import { type Tap } from "../operations/tap";
import { type Exchange } from "../exchange";

export class LogAdapter<T = unknown> implements Destination<T>, Tap<T> {
  readonly adapterId = "routecraft.adapter.log";

  send(exchange: Exchange<T>): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(this.baseExchange(exchange));
    return Promise.resolve();
  }

  tap(exchange: Exchange<T>): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(this.baseExchange(exchange));
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}
