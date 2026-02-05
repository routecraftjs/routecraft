import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
} from "../exchange.ts";
import { type Destination, type CallableDestination } from "./to.ts";

/** Aggregator used by .enrich() to merge destination result with the current exchange. */
export type DestinationAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  enrichmentData: R,
) => Exchange<T>;

/**
 * Default aggregator for .enrich() - merges the result into the exchange body.
 *
 * This aggregator:
 * 1. Returns original exchange if enrichment data is undefined or null
 * 2. Converts the original body to an object if it's not already one (using {value: originalBody})
 * 3. Converts the enrichment data to an object if it's not already one (using {value: enrichmentData})
 * 4. Merges these objects using spread syntax ({...originalBody, ...enrichmentObject})
 *
 * Note: If both the original body and enrichment data have a 'value' property,
 * the enrichment data's 'value' will overwrite the original's 'value'.
 */
export const defaultEnrichAggregator = <T = unknown, R = unknown>(
  original: Exchange<T>,
  enrichmentData: R,
): Exchange<T> => {
  // Handle undefined/null results - no enrichment to add
  if (enrichmentData === undefined || enrichmentData === null) {
    return original;
  }

  // Convert original body to object if it's not already
  const originalBody =
    typeof original.body === "object" && original.body !== null
      ? original.body
      : { value: original.body };

  // Convert enrichment data to object if it's not already
  const enrichmentObject =
    typeof enrichmentData === "object" && enrichmentData !== null
      ? enrichmentData
      : { value: enrichmentData };

  // Merge the objects into original exchange body
  original.body = {
    ...originalBody,
    ...enrichmentObject,
  } as T;

  return original;
};

/**
 * Step that enriches the exchange with additional data from a destination adapter.
 * Uses the same Destination adapters as .to() but with a different default aggregator.
 */
export class EnrichStep<T = unknown, R = unknown> implements Step<
  Destination<T, R>
> {
  operation: OperationType = OperationType.ENRICH;
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
    queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    // Get the enrichment data by calling the destination's send method
    const enrichmentData = await Promise.resolve(this.adapter.send(exchange));

    // Use the provided aggregator or the default one
    const aggregator = this.aggregator || defaultEnrichAggregator;

    // Aggregate the original exchange with the enrichment data
    const result = await Promise.resolve(aggregator(exchange, enrichmentData));

    // If aggregator returned a different exchange, copy properties back
    if (result !== exchange) {
      exchange.body = result.body;
      (exchange as { headers: ExchangeHeaders }).headers = result.headers;
    }

    // Push the exchange to the queue
    queue.push({ exchange, steps: remainingSteps });
  }
}
