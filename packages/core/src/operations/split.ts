import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType, HeadersKeys } from "../exchange.ts";

export type CallableSplitter<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>[]> | Exchange<R>[];

export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split: CallableSplitter<T, R>;
}

export class SplitStep<T = unknown, R = unknown>
  implements StepDefinition<Splitter<T, R>>
{
  operation: OperationType = OperationType.SPLIT;
  adapter: Splitter<T, R>;

  constructor(adapter: Splitter<T, R> | CallableSplitter<T, R>) {
    this.adapter = typeof adapter === "function" ? { split: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<R>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    const splits = await Promise.resolve(this.adapter.split(exchange));
    const groupId = crypto.randomUUID();

    const existingHierarchy =
      (exchange.headers[HeadersKeys.SPLIT_HIERARCHY] as string[]) || [];
    const splitHierarchy = [...existingHierarchy, groupId];

    splits.forEach((exch) => {
      const postProcessedExchange = {
        ...exch,
        id: crypto.randomUUID(),
        headers: {
          ...exch.headers,
          [HeadersKeys.SPLIT_HIERARCHY]: splitHierarchy,
        },
      };
      postProcessedExchange.logger.debug(
        `Pushing split exchange ${postProcessedExchange.id} to queue, splitHierarchy: ${postProcessedExchange.headers[HeadersKeys.SPLIT_HIERARCHY]}`,
      );
      queue.push({
        exchange: postProcessedExchange,
        steps: remainingSteps,
      });
    });
  }
}
