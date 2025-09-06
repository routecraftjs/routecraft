import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType, HeadersKeys } from "../exchange.ts";

export type CallableAggregator<T = unknown, R = T> = (
  exchanges: Exchange<T>[],
) => Promise<Exchange<R>> | Exchange<R>;

export interface Aggregator<T = unknown, R = unknown> extends Adapter {
  aggregate: CallableAggregator<T, R>;
}

export class AggregateStep<T = unknown, R = unknown>
  implements Step<Aggregator<T, R>>
{
  operation: OperationType = OperationType.AGGREGATE;
  adapter: Aggregator<T, R>;

  constructor(adapter: Aggregator<T, R> | CallableAggregator<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { aggregate: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const splitHierarchy = exchange.headers[
      HeadersKeys.SPLIT_HIERARCHY
    ] as string[];

    // If there's no split hierarchy, just aggregate the single exchange
    if (!splitHierarchy) {
      const aggregatedExchange = await Promise.resolve(
        this.adapter.aggregate([exchange]),
      );
      queue.push({
        exchange: aggregatedExchange,
        steps: remainingSteps,
      });
      return;
    }

    const currentGroupId = splitHierarchy[splitHierarchy.length - 1];
    const aggregationGroup: Exchange[] = [exchange];

    for (let i = 0; i < queue.length; ) {
      const item = queue[i];
      const itemHierarchy = item.exchange.headers[
        HeadersKeys.SPLIT_HIERARCHY
      ] as string[];
      if (itemHierarchy?.at(-1) === currentGroupId) {
        aggregationGroup.push(item.exchange);
        queue.splice(i, 1);
      } else {
        i++;
      }
    }

    const aggregatedExchange = await Promise.resolve(
      this.adapter.aggregate(aggregationGroup as Exchange<T>[]),
    );

    // Remove the current group from hierarchy after aggregation
    const remainingHierarchy = splitHierarchy.slice(0, -1);
    if (remainingHierarchy.length > 0) {
      aggregatedExchange.headers[HeadersKeys.SPLIT_HIERARCHY] =
        remainingHierarchy;
    } else {
      delete aggregatedExchange.headers[HeadersKeys.SPLIT_HIERARCHY];
    }

    queue.push({
      exchange: aggregatedExchange,
      steps: remainingSteps,
    });
  }
}
