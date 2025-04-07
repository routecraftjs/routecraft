import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange } from "../exchange.ts";
import { OperationType } from "../exchange.ts";

export type CallableProcessor<T = unknown, R = T> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>> | Exchange<R>;

export interface Processor<T = unknown, R = T> extends Adapter {
  process: CallableProcessor<T, R>;
}

export class ProcessStep<T = unknown, R = T>
  implements StepDefinition<Processor<T, R>>
{
  operation: OperationType = OperationType.PROCESS;
  adapter: Processor<T, R>;

  constructor(adapter: Processor<T, R> | CallableProcessor<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { process: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<R>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    const newExchange = await Promise.resolve(this.adapter.process(exchange));
    queue.push({ exchange: newExchange, steps: remainingSteps });
  }
}
