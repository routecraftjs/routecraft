import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, type ExchangeHeaders } from "../exchange.ts";
import { OperationType } from "../exchange.ts";

/**
 * Represents the result of an enrichment operation
 * Can be either just the body or an object with body and optional headers
 */
export type EnrichResult<R = unknown> =
  | R
  | { body: R; headers?: ExchangeHeaders };

/**
 * Function that produces enrichment data based on the original exchange
 * Specifically designed for the enrich operation
 */
export type CallableEnricher<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<EnrichResult<R>> | EnrichResult<R>;

/**
 * Interface for an adapter that can produce enrichment data
 * Specifically designed for the enrich operation
 */
export interface Enricher<T = unknown, R = unknown> extends Adapter {
  enrich: CallableEnricher<T, R>;
  adapterId: string;
}

/**
 * Function that aggregates the original exchange with the enrichment exchange
 * Similar to CallableAggregator but specifically for the enrich operation
 */
export type EnrichAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  enrichment: Exchange<R>,
) => Promise<Exchange<T>> | Exchange<T>;

/**
 * Default aggregator that merges the body and headers of the enrichment exchange into the original exchange
 */
export const defaultEnrichAggregator = <T = unknown, R = unknown>(
  original: Exchange<T>,
  enrichment: Exchange<R>,
): Exchange<T> => {
  // Create a new body by merging the original body with the enrichment body
  const newBody = {
    ...original.body,
    ...enrichment.body,
  } as T;

  // Create new headers by merging the original headers with the enrichment headers
  const newHeaders: ExchangeHeaders = {
    ...original.headers,
    ...enrichment.headers,
  };

  // Return the original exchange with the new body and headers
  return {
    ...original,
    body: newBody,
    headers: newHeaders,
  };
};

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
            adapterId: "routecraft.adapter.callable-enricher",
          }
        : adapter;
    this.aggregator = aggregator;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    try {
      // Produce the enrichment data
      const enrichmentResult = await Promise.resolve(
        this.adapter.enrich(exchange),
      );

      // Determine if the result has body and headers or is just the body
      let enrichmentBody: R;
      let enrichmentHeaders: ExchangeHeaders = {};

      if (
        enrichmentResult !== null &&
        typeof enrichmentResult === "object" &&
        "body" in enrichmentResult
      ) {
        // Result has a body property (it's an EnrichResult with body and headers)
        enrichmentBody = (enrichmentResult as { body: R }).body;
        // If headers are provided, use them
        if ("headers" in enrichmentResult && enrichmentResult.headers) {
          enrichmentHeaders = (enrichmentResult as { headers: ExchangeHeaders })
            .headers;
        }
      } else {
        // Result is just the body (it's an EnrichResult that's just the value)
        enrichmentBody = enrichmentResult as R;
      }

      // Create an enrichment exchange
      const enrichmentExchange: Exchange<R> = {
        id: crypto.randomUUID(),
        headers: enrichmentHeaders,
        body: enrichmentBody,
        logger: exchange.logger,
      };

      // Use the aggregator to combine the original and enrichment exchanges
      const actualAggregator = this.aggregator || defaultEnrichAggregator;
      const enrichedExchange = await Promise.resolve(
        actualAggregator(exchange, enrichmentExchange),
      );

      // Continue with the enriched exchange
      queue.push({
        exchange: enrichedExchange as Exchange,
        steps: remainingSteps,
      });
    } catch (error) {
      exchange.logger.error(error, "Failed to enrich exchange");
      throw error;
    }
  }
}
