import { type Destination } from "../operations/to";
import { type Processor } from "../operations/process";
import { type Tap } from "../operations/tap";
import { type Exchange } from "../exchange";

export class LogAdapter<T = unknown>
  implements Destination<T>, Processor<T>, Tap<T>
{
  readonly adapterId = "routecraft.adapter.log";

  send(exchange: Exchange<T>): Promise<void> {
    // Direct logging to console for now (binder removed)
    // eslint-disable-next-line no-console
    console.log(this.baseExchange(exchange));
    return Promise.resolve();
  }

  process(exchange: Exchange<T>): Promise<Exchange<T>> {
    // eslint-disable-next-line no-console
    console.log(this.baseExchange(exchange));
    return Promise.resolve(exchange);
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
