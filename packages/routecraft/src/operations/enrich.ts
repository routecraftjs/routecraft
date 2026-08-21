import { ENRICH_MERGE_TYPE } from "../brand.ts";
import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
  type StepSignalContext,
  extractOutcomeMetadata,
  toSignalContext,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  getExchangeContext,
  DefaultExchange,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { hasFetch } from "./adapter-roles.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";
import { SUSPEND_HOST } from "../dsl-symbol.ts";
import type { SuspendCapableStep, SuspendSite } from "../suspension/sites.ts";
import { convertSuspendSignal, isSuspendSignal } from "../suspension/signal.ts";

/**
 * Function form of an enricher: receives the exchange and produces a value
 * (a lookup result, a file's parsed content, an API response). Used with
 * `.enrich()`, and accepted by `.to()` / `.tap()` where the returned value
 * replaces the body / is discarded respectively.
 *
 * The second argument carries the step's {@link StepSignalContext}: when an
 * enclosing `.timeout()` expires, `ctx.signal` aborts, so an enricher doing
 * cancellation-aware IO can forward it (`fetch(url, { signal })`). Declaring
 * only the first parameter remains valid.
 *
 * @template T - Current body type
 * @template R - Produced value type
 */
export type CallableEnricher<
  T = unknown,
  R = unknown,
  Ex extends Exchange<T> = Exchange<T>,
> = (exchange: Ex, ctx?: StepSignalContext) => Promise<R> | R;

/**
 * Enricher adapter: pulls a value IN per exchange (HTTP GET, file read, IMAP
 * fetch, LLM call). Used with `.enrich()`; also accepted by `.to()` (the
 * result replaces the body) and `.tap()` (the result is discarded).
 *
 * The pull-in counterpart of {@link Destination}: `send` pushes out and is
 * void, `fetch` pulls in and produces a value. An adapter may implement both
 * roles on one object (e.g. `file()`: send writes, fetch reads); the
 * operation keyword selects the role, and `.to()` prefers `send`.
 *
 * @template T - Current body type
 * @template R - Produced value type
 */
export interface Enricher<T = unknown, R = unknown> extends Adapter {
  fetch: CallableEnricher<T, R>;
}

/**
 * Aggregator used by `.enrich()` to merge the fetched value with the current
 * exchange. Receives the original exchange and the enrichment result; returns
 * the (derived) exchange.
 *
 * @template T - Current body type
 * @template R - Type produced by the enricher
 */
export type EnrichAggregator<T = unknown, R = unknown> = (
  original: Exchange<T>,
  enrichmentData: R,
) => Exchange<T>;

/**
 * When an aggregator is branded with [ENRICH_MERGE_TYPE], `.enrich()` infers the result body as `Current & shape`.
 * Used by `only(getValue, into)` when `into` is a string literal for type inference.
 */
export type EnrichMergeShape = Record<string, unknown>;

/**
 * Returns an aggregator for `.enrich()` that merges a single value from the enrichment result into the body.
 *
 * - `getValue(enrichmentData)` extracts the value; null/undefined are not merged.
 * - If `into` is omitted: plain objects are spread onto body; primitives go to `body.stdout`; arrays to `body.array`.
 * - If `into` is provided: the value is set at `body[into]`. When `into` is a string literal, the builder infers body as `Current & { [into]: V }`.
 *
 * @param getValue - Function to extract the value from the enrichment result
 * @param into - Optional key to set on body (enables type inference when a string literal)
 * @returns An aggregator usable with `.enrich(enricher, aggregator)`
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
): EnrichAggregator<unknown, unknown> & {
  [ENRICH_MERGE_TYPE]: Record<K, V>;
};
export function only<T = unknown, R = unknown, V = unknown>(
  getValue: (enrichmentData: R) => V,
  into?: string,
): EnrichAggregator<T, R>;
export function only<T = unknown, R = unknown, V = unknown>(
  getValue: (enrichmentData: R) => V,
  into?: string,
): EnrichAggregator<T, R> {
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
      return { ...original, body: { ...originalBody, [into]: value } as T };
    }

    const isPlainObject =
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (isPlainObject) {
      return {
        ...original,
        body: {
          ...originalBody,
          ...(value as Record<string, unknown>),
        } as T,
      };
    }
    if (Array.isArray(value)) {
      return { ...original, body: { ...originalBody, array: value } as T };
    }
    return { ...original, body: { ...originalBody, stdout: value } as T };
  };
}

/**
 * No-op aggregator for `.enrich()`: returns the original exchange unchanged (enrichment is ignored).
 * Use when you only need the side effect of the fetch (e.g. warming a cache) while gating the pipeline on it.
 *
 * @example
 * ```typescript
 * .enrich(http({ url: 'https://api.example.com/ping' }), none())
 * ```
 */
export const none = <T = unknown, R = unknown>(): EnrichAggregator<T, R> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- second param required by signature, intentionally unused
  return (original: Exchange<T>, _ignored: R): Exchange<T> => {
    return original;
  };
};

/**
 * Aggregator type accepted by EnrichStep. Includes `only()` return type (with [ENRICH_MERGE_TYPE]) for body-type inference.
 */
export type EnrichAggregatorOption<T, R> =
  | EnrichAggregator<T, R>
  | (EnrichAggregator<unknown, unknown> & {
      [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
    });

/**
 * Step that enriches the exchange with data pulled in by an {@link Enricher}
 * (e.g. HTTP lookup, file read). With no aggregator the fetched value
 * REPLACES the body; pass an aggregator (`only()`, `none()`, or a custom
 * function) to merge instead.
 */
export class EnrichStep<T = unknown, R = unknown>
  implements Step<Adapter>, SuspendCapableStep
{
  operation: OperationType = OperationType.ENRICH;
  adapter: Adapter;
  aggregator: EnrichAggregatorOption<T, R> | undefined;
  /** Assigned by the suspend-site walk when the adapter is suspend-capable. */
  suspendSite?: SuspendSite;
  /** Why the walk refused a site (fan-out or sealed side flow), when it did. */
  suspendRefusal?: string;

  /** This step hosts its own suspend site; wrappers forward here. @internal */
  [SUSPEND_HOST](): SuspendCapableStep {
    return this;
  }

  constructor(
    enricher: Enricher<T, R> | CallableEnricher<T, R>,
    aggregator?: EnrichAggregatorOption<T, R>,
  ) {
    this.adapter =
      typeof enricher === "function" ? { fetch: enricher } : enricher;
    this.aggregator = aggregator;
  }

  async execute(
    exchange: Exchange<T>,
    ctx?: StepContext,
  ): Promise<StepOutcome> {
    // Resolve a test-time override (if any) registered on the context.
    const override = resolveAdapterOverride(
      this.adapter,
      getExchangeContext(exchange),
      "send",
    );

    // Pull the enrichment data through the fetch slot (or the mock handler
    // when an override is registered).
    let enrichmentData: R;
    try {
      if (override) {
        enrichmentData = (await invokeSendOverride(
          exchange,
          this.adapter,
          override,
        )) as R;
      } else {
        if (!hasFetch<T, R>(this.adapter)) {
          throw rcError("RC5003", undefined, {
            message: "`.enrich()` target does not implement `fetch`",
            suggestion:
              "Enrichment pulls data in; pass an Enricher (fetch) or a function form. Push-out sends belong in `.to()` / `.tap()`",
          });
        }
        enrichmentData = await Promise.resolve(
          this.adapter.fetch(exchange, toSignalContext(ctx)),
        );
      }
    } catch (err) {
      // Converted here, inside the step, so a step-scope wrapper never
      // observes the raw throw (a retry wrapper would re-run the adapter
      // and charge the parked work twice).
      if (isSuspendSignal(err)) {
        return convertSuspendSignal(this, exchange, err);
      }
      throw err;
    }

    // The metadata rides the OUTCOME, not the step: Step instances are
    // shared across exchanges.
    const metadata = extractOutcomeMetadata(
      this.adapter,
      enrichmentData,
      !!override,
      "getMetadata",
      exchange,
    );

    // No aggregator: the fetched value replaces the body. `undefined` (e.g.
    // a mock override with no handler) leaves the exchange unchanged.
    if (this.aggregator === undefined) {
      const next =
        enrichmentData === undefined
          ? (exchange as Exchange<unknown>)
          : DefaultExchange.rewrap<unknown>(exchange, {
              body: enrichmentData,
            });
      return {
        kind: "continue",
        exchange: next,
        ...(metadata ? { metadata } : {}),
      };
    }

    // Aggregator returns a (possibly new) exchange. The fast-path is
    // identity equality (aggregator returned the same input); anything
    // else -- plain spread, freshly constructed DefaultExchange,
    // foreign-context exchange -- is always rewrapped onto THIS
    // exchange's internals so route binding / context survive the
    // aggregator and principal sticky-set semantics stay consistent.
    const result = (await Promise.resolve(
      this.aggregator(exchange, enrichmentData),
    )) as Exchange<T>;

    const next: Exchange<T> =
      result === exchange
        ? exchange
        : DefaultExchange.rewrap<T>(exchange, {
            body: result.body,
            headers: result.headers,
          });

    return {
      kind: "continue",
      exchange: next,
      ...(metadata ? { metadata } : {}),
    };
  }
}
