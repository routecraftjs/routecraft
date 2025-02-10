import { OperationType } from "./exchange.ts";
import {
  type Destination,
  type Processor,
  type Splitter,
  type Aggregator,
  type Adapter,
  type CallableProcessor,
  type CallableDestination,
  type CallableSplitter,
  type CallableAggregator,
  type CallableTransformer,
  type Transformer,
  type Tap,
  type CallableTap,
} from "./adapter.ts";
import { type Exchange, HeadersKeys } from "./exchange.ts";
import { RouteCraftError, ErrorCode } from "./error.ts";

export interface StepDefinition<T extends Adapter> {
  operation: OperationType;
  adapter: T;

  execute(
    exchange: Exchange,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void>;
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

export class AggregateStep<T = unknown, R = unknown>
  implements StepDefinition<Aggregator<T, R>>
{
  operation: OperationType = OperationType.AGGREGATE;
  adapter: Aggregator<T, R>;

  constructor(adapter: Aggregator<T, R> | CallableAggregator<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { aggregate: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<R>; steps: StepDefinition<Adapter>[] }[],
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

export class TapStep<T = unknown> implements StepDefinition<Tap<T>> {
  operation: OperationType = OperationType.TAP;
  adapter: Tap<T>;

  constructor(adapter: Tap<T> | CallableTap<T>) {
    this.adapter = typeof adapter === "function" ? { tap: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    // Create a deep copy of the exchange for the tap
    const exchangeCopy: Exchange<T> = {
      ...exchange,
      body: structuredClone(exchange.body),
      headers: structuredClone(exchange.headers),
    };

    try {
      // Tap is not considered a critical step, so we don't want to throw an error
      await this.adapter.tap(exchangeCopy);
    } catch (error: unknown) {
      const err = RouteCraftError.create(error, {
        code: ErrorCode.TAP_ERROR,
        message: `Error tapping exchange ${exchangeCopy.id}`,
        suggestion:
          "Check the tap function for any errors or wrap it in a try/catch block.",
      });
      exchangeCopy.logger.info(
        err,
        `Error tapping exchange ${exchangeCopy.id}`,
      );
    }
    queue.push({ exchange, steps: remainingSteps });
  }
}
