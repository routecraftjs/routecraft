import { type Adapter, type Step, getAdapterLabel } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { error as rcError } from "../error.ts";

/**
 * Function that evaluates a predicate against the entire Exchange.
 * Returns true to keep the exchange, false to filter it out.
 * Can evaluate headers, body, and other exchange properties.
 */
export type CallableFilter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<boolean> | boolean;

export interface Filter<T = unknown> extends Adapter {
  filter: CallableFilter<T>;
}

/**
 * Filter: evaluate predicate against the entire Exchange.
 * - Receives full Exchange (allows filtering on headers, body, and other properties)
 * - Returns true to continue, false to reject the exchange
 * - Use when you need to filter based on headers or other exchange metadata
 * - For body-only transformations, use `.transform` instead
 */
export class FilterStep<T = unknown> implements Step<Filter<T>> {
  operation: OperationType = OperationType.FILTER;
  adapter: Filter<T>;

  constructor(adapter: Filter<T> | CallableFilter<T>) {
    this.adapter =
      typeof adapter === "function" ? { filter: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const adapterLabel = getAdapterLabel(this.adapter);
    try {
      const result = await Promise.resolve(this.adapter.filter(exchange));
      if (!result) {
        exchange.logger.debug(
          {
            operation: "filter",
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
          },
          "Filter rejected exchange",
        );
        return;
      }
    } catch (error: unknown) {
      throw rcError("RC5001", error, {
        message: "Filter predicate threw",
      });
    }
    queue.push({ exchange, steps: remainingSteps });
  }
}
