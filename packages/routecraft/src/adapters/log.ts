import { type Destination } from "../operations/to";
import { type Processor } from "../operations/process";
import { type Tap } from "../operations/tap";
import { type Exchange } from "../exchange";
import { type Binder, BinderBackedAdapter } from "../types";

export class LogAdapter<T = unknown>
  extends BinderBackedAdapter<LogBinder>
  implements Destination<T>, Processor<T>, Tap<T>
{
  readonly adapterId = "routecraft.adapter.log";
  static readonly binderKind = "log";

  send(exchange: Exchange<T>): Promise<void> {
    this.binder.log(this.baseExchange(exchange));
    return Promise.resolve();
  }

  process(exchange: Exchange<T>): Promise<Exchange<T>> {
    this.binder.log(this.baseExchange(exchange));
    return Promise.resolve(exchange);
  }

  tap(exchange: Exchange<T>): Promise<void> {
    this.binder.log(this.baseExchange(exchange));
    return Promise.resolve();
  }

  private baseExchange(exchange: Exchange<T>): Partial<Exchange<T>> {
    const { id, body, headers } = exchange;
    return { id, body, headers };
  }
}

export interface LogBinder extends Binder {
  readonly type: "log";
  log(message?: unknown, ...optionalParams: unknown[]): void | Promise<void>;
}
