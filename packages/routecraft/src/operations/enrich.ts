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
 * When an aggregator has __enrichMerge, .enrich() infers the result body type as Current & __enrichMerge.
 * Used by only(getValue, into) when into is a string literal.
 */
export type EnrichMergeShape = Record<string, unknown>;

/**
 * Default aggregator for .enrich() - merges the result into the exchange body.
 *
 * - If enrichment data is undefined or null, returns the original exchange unchanged.
 * - If enrichment data is an object, it is spread onto the body (no wrapping).
 * - If enrichment data is a primitive (e.g. string), it cannot be spread, so it is
 *   set as body.stdout and merged with the original body.
 * - If the original body is not an object, it is treated as body.stdout before merging.
 */
export const defaultEnrichAggregator = <T = unknown, R = unknown>(
  original: Exchange<T>,
  enrichmentData: R,
): Exchange<T> => {
  if (enrichmentData === undefined || enrichmentData === null) {
    return original;
  }

  const isEnrichmentObject =
    typeof enrichmentData === "object" && enrichmentData !== null;
  const isBodyObject =
    typeof original.body === "object" && original.body !== null;

  const originalBody = isBodyObject ? original.body : { stdout: original.body };
  const enrichmentObject = isEnrichmentObject
    ? (enrichmentData as Record<string, unknown>)
    : { stdout: enrichmentData };

  original.body = {
    ...originalBody,
    ...enrichmentObject,
  } as T;

  return original;
};

/**
 * Returns an aggregator for .enrich() that merges a single extracted value into the exchange body.
 * When `into` is omitted: plain objects are spread onto body; strings/primitives go to body.stdout;
 * arrays go to body.array. When `into` is provided, the value is set at body[into].
 * Null/undefined from getValue is never merged (exchange unchanged).
 * When `into` is a string literal, .enrich() infers the result body type as Current & { [into]: V }.
 * Returns DestinationAggregator<unknown, unknown> & __enrichMerge; the builder accepts this via a union.
 */
export function only<R, V, K extends string>(
  getValue: (enrichmentData: R) => V,
  into: K,
): DestinationAggregator<unknown, unknown> & { __enrichMerge: Record<K, V> };
export function only<T = unknown, R = unknown, V = unknown>(
  getValue: (enrichmentData: R) => V,
  into?: string,
): DestinationAggregator<T, R>;
export function only<T = unknown, R = unknown, V = unknown>(
  getValue: (enrichmentData: R) => V,
  into?: string,
): DestinationAggregator<T, R> {
  return (original: Exchange<T>, enrichmentData: R): Exchange<T> => {
    const value = getValue(enrichmentData);
    if (value === undefined || value === null) {
      return original;
    }

    const isBodyObject =
      typeof original.body === "object" && original.body !== null;
    const originalBody = isBodyObject
      ? (original.body as Record<string, unknown>)
      : { stdout: original.body };

    if (into !== undefined) {
      original.body = { ...originalBody, [into]: value } as T;
      return original;
    }

    const isPlainObject =
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (isPlainObject) {
      original.body = {
        ...originalBody,
        ...(value as Record<string, unknown>),
      } as T;
      return original;
    }
    if (Array.isArray(value)) {
      original.body = { ...originalBody, array: value } as T;
      return original;
    }
    original.body = { ...originalBody, stdout: value } as T;
    return original;
  };
}

/** No-op aggregator for .enrich() - returns the original exchange unchanged. */
export const none = <T = unknown, R = unknown>(): DestinationAggregator<
  T,
  R
> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- second param required by signature, intentionally unused
  return (original: Exchange<T>, _ignored: R): Exchange<T> => {
    return original;
  };
};

/**
 * Step that enriches the exchange with additional data from a destination adapter.
 * Uses the same Destination adapters as .to() but with a different default aggregator.
 */
/** Aggregator type accepted by EnrichStep; includes branded only() return for body-type inference. */
export type EnrichAggregatorOption<T, R> =
  | DestinationAggregator<T, R>
  | (DestinationAggregator<unknown, unknown> & {
      __enrichMerge?: EnrichMergeShape;
    });

export class EnrichStep<T = unknown, R = unknown> implements Step<
  Destination<T, R>
> {
  operation: OperationType = OperationType.ENRICH;
  adapter: Destination<T, R>;
  aggregator: EnrichAggregatorOption<T, R> | undefined;

  constructor(
    adapter: Destination<T, R> | CallableDestination<T, R>,
    aggregator?: EnrichAggregatorOption<T, R>,
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

    // Aggregate the original exchange with the enrichment data (aggregator mutates exchange in place)
    const result = (await Promise.resolve(
      aggregator(exchange, enrichmentData),
    )) as Exchange<T>;

    // If aggregator returned a different exchange, copy properties back
    if (result !== exchange) {
      exchange.body = result.body;
      (exchange as { headers: ExchangeHeaders }).headers = result.headers;
    }

    // Push the exchange to the queue
    queue.push({ exchange, steps: remainingSteps });
  }
}
