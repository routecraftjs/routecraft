import { type Adapter, type Step, getAdapterLabel } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { error as rcError } from "../error.ts";

/**
 * Predicate over the full exchange. Return true to keep the exchange, false to drop it.
 * Use with `.filter(predicate)`. Can inspect headers, body, and other exchange fields.
 *
 * @template T - Body type of the exchange
 */
export type CallableFilter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<boolean> | boolean;

/**
 * Filter adapter: keeps or drops the exchange based on a predicate. Used with `.filter()`.
 *
 * @template T - Body type
 */
export interface Filter<T = unknown> extends Adapter {
  filter: CallableFilter<T>;
}

/**
 * Step that runs a predicate on the exchange. If the predicate returns false, the exchange is dropped (no further steps).
 * If it throws, the error is wrapped as RC5001.
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
