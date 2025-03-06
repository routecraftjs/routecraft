import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

export type CallableTransformer<T = unknown, R = T> = (
  message: T,
) => Promise<R> | R;

export interface Transformer<T = unknown, R = T> extends Adapter {
  transform: CallableTransformer<T, R>;
}

export class TransformStep<T = unknown, R = T>
  implements StepDefinition<Transformer<T, R>>
{
  operation: OperationType = OperationType.TRANSFORM;
  adapter: Transformer<T, R>;

  constructor(adapter: Transformer<T, R> | CallableTransformer<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { transform: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<R>; steps: StepDefinition<Adapter>[] }[],
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
