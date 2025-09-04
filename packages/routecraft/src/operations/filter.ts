import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { RouteCraftError, ErrorCode } from "../error.ts";

export type CallableFilter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<boolean> | boolean;

export interface Filter<T = unknown> extends Adapter {
  filter: CallableFilter<T>;
}

export class FilterStep<T = unknown> implements StepDefinition<Filter<T>> {
  operation: OperationType = OperationType.FILTER;
  adapter: Filter<T>;

  constructor(adapter: Filter<T> | CallableFilter<T>) {
    this.adapter =
      typeof adapter === "function" ? { filter: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    try {
      const result = await Promise.resolve(this.adapter.filter(exchange));
      if (!result) {
        exchange.logger.debug(`Filter rejected exchange ${exchange.id}`);
        return;
      }
    } catch (error: unknown) {
      const err = RouteCraftError.create(error, {
        code: ErrorCode.FILTER_ERROR,
        message: `Error filtering exchange ${exchange.id}`,
        docs: "https://routecraft.dev/docs/reference/errors#filter-error",
      });
      exchange.logger.warn(err, `Error filtering exchange ${exchange.id}`);
    }
    queue.push({ exchange, steps: remainingSteps });
  }
}
