import { OperationType } from "./exchange.ts";
import {
  type Destination,
  type Processor,
  type Splitter,
  type Aggregator,
  type Adapter,
} from "./adapter.ts";
import { type Exchange, HeadersKeys } from "./exchange.ts";

export interface StepDefinition<T extends Adapter> {
  operation: OperationType;
  adapterId: string;
  adapter: T;

  execute(
    exchange: Exchange,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void>;
}

export class ProcessStep<T = unknown> implements StepDefinition<Processor<T>> {
  operation: OperationType = OperationType.PROCESS;
  adapterId: string;
  adapter: Processor<T>;

  constructor(adapterId: string, adapter: Processor<T>) {
    this.adapterId = adapterId;
    this.adapter = adapter;
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

export class ToStep<T = unknown> implements StepDefinition<Destination<T>> {
  operation: OperationType = OperationType.TO;
  adapterId: string;
  adapter: Destination<T>;

  constructor(adapterId: string, adapter: Destination<T>) {
    this.adapterId = adapterId;
    this.adapter = adapter;
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

export class SplitStep<T = unknown> implements StepDefinition<Splitter<T>> {
  operation: OperationType = OperationType.SPLIT;
  adapterId: string;
  adapter: Splitter<T>;

  constructor(adapterId: string, adapter: Splitter<T>) {
    this.adapterId = adapterId;
    this.adapter = adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
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
        exchange: postProcessedExchange as Exchange<T>,
        steps: remainingSteps,
      });
    });
  }
}

export class AggregateStep<T = unknown>
  implements StepDefinition<Aggregator<T>>
{
  operation: OperationType = OperationType.AGGREGATE;
  adapterId: string;
  adapter: Aggregator<T>;

  constructor(adapterId: string, adapter: Aggregator<T>) {
    this.adapterId = adapterId;
    this.adapter = adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
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
        exchange: aggregatedExchange as Exchange<T>,
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
      exchange: aggregatedExchange as Exchange<T>,
      steps: remainingSteps,
    });
  }
}
