import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

export type CallableDestination<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<void> | void;

export interface Destination<T = unknown> extends Adapter {
  send: CallableDestination<T>;
}

export class ToStep<T = unknown> implements StepDefinition<Destination<T>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T>;

  constructor(adapter: Destination<T> | CallableDestination<T>) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    await this.adapter.send(exchange);
    queue.push({ exchange, steps: remainingSteps });
  }
}
