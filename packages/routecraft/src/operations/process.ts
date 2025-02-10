import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange } from "../exchange.ts";
import { OperationType } from "../exchange.ts";

export type CallableProcessor<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<Exchange<T>> | Exchange<T>;

export interface Processor<T = unknown> extends Adapter {
  process: CallableProcessor<T>;
}

export class ProcessStep<T = unknown> implements StepDefinition<Processor<T>> {
  operation: OperationType = OperationType.PROCESS;
  adapter: Processor<T>;

  constructor(adapter: Processor<T> | CallableProcessor<T>) {
    this.adapter =
      typeof adapter === "function" ? { process: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    const newExchange = await Promise.resolve(this.adapter.process(exchange));
    queue.push({ exchange: newExchange, steps: remainingSteps });
  }
}
