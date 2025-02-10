import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

export type CallableTransformer<T = unknown> = (message: T) => Promise<T> | T;

export interface Transformer<T = unknown> extends Adapter {
  transform: CallableTransformer<T>;
}

export class TransformStep<T = unknown>
  implements StepDefinition<Transformer<T>>
{
  operation: OperationType = OperationType.TRANSFORM;
  adapter: Transformer<T>;

  constructor(adapter: Transformer<T> | CallableTransformer<T>) {
    this.adapter =
      typeof adapter === "function" ? { transform: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    const newBody = await Promise.resolve(
      this.adapter.transform(exchange.body),
    );
    queue.push({
      exchange: { ...exchange, body: newBody },
      steps: remainingSteps,
    });
  }
}
