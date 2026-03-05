import { ENRICH_MERGE_TYPE } from "../brand.ts";
import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
} from "../exchange.ts";
import { type Destination, type CallableDestination } from "./to.ts";

/**
 * Aggregator used by `.enrich()` to merge the destination result with the current exchange.
 * Receives the original exchange and the enrichment result; returns the (possibly mutated) exchange.
 *
 * @template T - Current body type
 * @template R - Type returned by the enrichment destination
 */
export type DestinationAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  enrichmentData: R,
) => Exchange<T>;

/**
 * When an aggregator is branded with [ENRICH_MERGE_TYPE], `.enrich()` infers the result body as `Current & shape`.
 * Used by `only(getValue, into)` when `into` is a string literal for type inference.
 */
export type EnrichMergeShape = Record<string, unknown>;

/**
 * Default aggregator for `.enrich()`: merges the enrichment result into the exchange body.
 *
 * - undefined/null: exchange unchanged.
 * - Object: spread onto body.
 * - Primitive/array: set at body.stdout or body.array; non-object bodies are wrapped as { stdout } first.
 *
 * @example
 * ```typescript
 * .enrich(http({ url: 'https://api.example.com/user' }))
 * // Response body is spread onto exchange.body; no need to pass aggregator.
 * ```
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
 * Returns an aggregator for `.enrich()` that merges a single value from the enrichment result into the body.
 *
 * - `getValue(enrichmentData)` extracts the value; null/undefined are not merged.
 * - If `into` is omitted: plain objects are spread onto body; primitives go to `body.stdout`; arrays to `body.array`.
 * - If `into` is provided: the value is set at `body[into]`. When `into` is a string literal, the builder infers body as `Current & { [into]: V }`.
 *
 * @param getValue - Function to extract the value from the enrichment result
 * @param into - Optional key to set on body (enables type inference when a string literal)
 * @returns An aggregator usable with `.enrich(destination, aggregator)`
 *
 * @example
 * ```typescript
 * .enrich(http({ url: (ex) => `https://api.example.com/users/${ex.body.userId}` }), only((r) => r.body.name, 'userName'))
 * // Body type becomes Current & { userName: string }
 * ```
 */
export function only<R, V, K extends string>(
  getValue: (enrichmentData: R) => V,
  into: K,
): DestinationAggregator<unknown, unknown> & {
  [ENRICH_MERGE_TYPE]: Record<K, V>;
};
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

/**
 * No-op aggregator for `.enrich()`: returns the original exchange unchanged (enrichment is ignored).
 * Use when you only need the side effect of calling the destination (e.g. logging or triggering an API).
 *
 * @example
 * ```typescript
 * .enrich(http({ url: 'https://api.example.com/ping' }), none())
 * ```
 */
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
 * Aggregator type accepted by EnrichStep. Includes `only()` return type (with [ENRICH_MERGE_TYPE]) for body-type inference.
 */
export type EnrichAggregatorOption<T, R> =
  | DestinationAggregator<T, R>
  | (DestinationAggregator<unknown, unknown> & {
      [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
    });

/**
 * Step that enriches the exchange with data from a destination (e.g. HTTP lookup).
 * Uses the same Destination adapters as `.to()`; by default merges the result into the body. Optional aggregator (e.g. `only()`, `none()`) controls how the result is merged.
 */
export class EnrichStep<T = unknown, R = unknown> implements Step<
  Destination<T, R>
> {
  operation: OperationType = OperationType.ENRICH;
  adapter: Destination<T, R>;
  aggregator: EnrichAggregatorOption<T, R> | undefined;
  metadata?: Record<string, unknown>;

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

    // Extract metadata if the adapter provides it
    const getMetadata = (
      this.adapter as {
        getMetadata?: (result: unknown) => Record<string, unknown>;
      }
    ).getMetadata;
    if (getMetadata) {
      this.metadata = getMetadata.call(this.adapter, enrichmentData);
    }

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
