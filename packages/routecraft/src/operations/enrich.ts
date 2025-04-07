import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange } from "../exchange.ts";
import { OperationType } from "../exchange.ts";

/**
 * Function that produces enrichment data based on the original exchange
 * Returns only the enriched data (body)
 */
export type CallableEnricher<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<R> | R;

/**
 * Interface for an adapter that can produce enrichment data
 * Specifically designed for the enrich operation
 */
export interface Enricher<T = unknown, R = unknown> extends Adapter {
  enrich: CallableEnricher<T, R>;
  adapterId: string;
}

/**
 * Function that aggregates the original exchange with the enrichment data
 * Similar to CallableAggregator but specifically for the enrich operation
 */
export type EnrichAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  enrichmentData: R,
) => Promise<Exchange<T>> | Exchange<T>;

/**
 * Default aggregator that merges the enrichment data with the original exchange body.
 *
 * This aggregator:
 * 1. Converts the original body to an object if it's not already one (using {value: originalBody})
 * 2. Converts the enrichment data to an object if it's not already one (using {value: enrichmentData})
 * 3. Merges these objects using spread syntax ({...originalBody, ...enrichmentObject})
 *
 * Note: If both the original body and enrichment data have a 'value' property,
 * the enrichment data's 'value' will overwrite the original's 'value'.
 */
export const defaultEnrichAggregator = <T = unknown, R = unknown>(
  original: Exchange<T>,
  enrichmentData: R,
): Exchange<T> => {
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

  // Merge the objects
  return {
    ...original,
    body: {
      ...originalBody,
      ...enrichmentObject,
    } as T,
  };
};

/**
 * Step that enriches the exchange with additional data
 */
export class EnrichStep<T = unknown, R = unknown>
  implements StepDefinition<Enricher<T, R>>
{
  operation: OperationType = OperationType.ENRICH;
  adapter: Enricher<T, R>;
  aggregator: EnrichAggregator<T, R> | undefined;

  constructor(
    adapter: Enricher<T, R> | CallableEnricher<T, R>,
    aggregator?: EnrichAggregator<T, R>,
  ) {
    this.adapter =
      typeof adapter === "function"
        ? {
            enrich: adapter,
            adapterId: crypto.randomUUID(),
          }
        : adapter;
    this.aggregator = aggregator;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    // Get the enrichment data
    const enrichmentData = await Promise.resolve(this.adapter.enrich(exchange));

    // Use the provided aggregator or the default one
    const aggregator = this.aggregator || defaultEnrichAggregator;

    // Aggregate the original exchange with the enrichment data
    const newExchange = await Promise.resolve(
      aggregator(exchange, enrichmentData),
    );

    // Push the new exchange to the queue
    queue.push({ exchange: newExchange, steps: remainingSteps });
  }
}
