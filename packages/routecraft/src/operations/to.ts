import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

/**
 * To (Destination): sends exchange to a destination and optionally aggregates the result.
 * - By default, returns original exchange unchanged (side-effect only)
 * - Can optionally capture and merge the result using a custom aggregator
 * - Use for IO boundaries (DB writes, HTTP emits, queues)
 */

export type CallableDestination<T = unknown, R = void> = (
  exchange: Exchange<T>,
) => Promise<R> | R;

export interface Destination<T = unknown, R = void> extends Adapter {
  send: CallableDestination<T, R>;
}

/**
 * Aggregator function that combines the original exchange with the destination result.
 */
export type DestinationAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  result: R,
) => Promise<Exchange<T>> | Exchange<T>;

/**
 * Default aggregator for .to() - returns original exchange unchanged (ignores result).
 */
export const defaultToAggregator = <T = unknown, R = unknown>(
  original: Exchange<T>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _result: R,
): Exchange<T> => original;

export class ToStep<T = unknown, R = void> implements Step<Destination<T, R>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T, R>;
  aggregator: DestinationAggregator<T, R> | undefined;

  constructor(
    adapter: Destination<T, R> | CallableDestination<T, R>,
    aggregator?: DestinationAggregator<T, R>,
  ) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
    this.aggregator = aggregator;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    // Call the destination and capture the result
    const result = await Promise.resolve(this.adapter.send(exchange));

    // Use the provided aggregator or the default one
    const aggregator = this.aggregator || defaultToAggregator;

    // Aggregate the original exchange with the result
    const newExchange = await Promise.resolve(aggregator(exchange, result));

    // Push the aggregated exchange to the queue
    queue.push({ exchange: newExchange, steps: remainingSteps });
  }
}
