import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange } from "../exchange.ts";
import { OperationType } from "../exchange.ts";

/**
 * Processor: mutate or derive a new Exchange from the current one.
 * - May change body, headers, and type
 * - Prefer pure logic; avoid side effects (use `.to(...)` for IO)
 * - Use when you need access to headers or want to replace the whole exchange
 */

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
