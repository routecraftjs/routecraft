import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  getStartedAt,
  DefaultExchange,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { SPLIT_PARENT_STORE } from "./split.ts";

/**
 * Function form of an aggregator: takes an array of exchanges and returns one combined exchange.
 * Use with `.aggregate(aggregator)`. Default aggregator collects bodies into an array.
 *
 * @template T - Body type of incoming exchanges
 * @template R - Result body type (default T)
 */
export type CallableAggregator<T = unknown, R = T> = (
  exchanges: Exchange<T>[],
) => Promise<Exchange<R>> | Exchange<R>;

/**
 * Helper type to extract the element type from an array type, or return the type itself.
 */
type ExtractArrayElement<T> = T extends Array<infer U> ? U : T;

/**
 * Helper type to determine the result type after flattening.
 * If T is an array type, extract its element type; otherwise use T itself.
 * The result is always an array of the flattened element type.
 */
type FlattenedAggregateResult<T> = T extends Array<infer U> ? U[] : T[];

/**
 * Default aggregator that collects exchange bodies into an array.
 * If any body is an array, all arrays are flattened ONE LEVEL and combined with scalar values.
 * Preserves the metadata from the first exchange.
 *
 * @template T The type of items in the exchanges
 * @param exchanges - Array of exchanges to aggregate
 * @returns Single exchange with array of bodies (flattened if any body was an array)
 *
 * @example
 * // All scalar values: [1, 2, 3]
 * // Mixed arrays and scalars: [1, 2, 3, 4, 5] (arrays flattened, scalars added)
 * // All arrays: [1, 2, 3, 4, 5] (all arrays flattened)
 * // Empty arrays are flattened away: [[], 1, []] → [1]
 * // Only one level deep: [[[1]], 2] → [[1], 2]
 */
export const defaultAggregate = <T>(
  exchanges: Exchange<T>[],
): Exchange<FlattenedAggregateResult<T>> => {
  if (exchanges.length === 0) {
    throw rcError("RC5002", undefined, {
      message: "Aggregator received empty array of exchanges",
      suggestion:
        "Ensure at least one exchange is available before aggregation",
    });
  }

  // Check if any body is an array
  const hasArrayBody = exchanges.some((x) => Array.isArray(x.body));

  // Spread-of-exchange (`{ ...exchanges[0], body }`) used to copy stored
  // fields like `principal` forward; with the unified state model only
  // `body` and `headers` are own-properties, so we hand the consuming
  // `AggregateStep` the explicit shape it needs (body + headers from the
  // first exchange). Identity, principal, and logger are derived from
  // headers via getters and reattach automatically when the engine wraps
  // the aggregate result back into a `DefaultExchange`.
  if (hasArrayBody) {
    // Flatten arrays and combine with scalar values
    const flattened: ExtractArrayElement<T>[] = [];
    for (const exchange of exchanges) {
      if (Array.isArray(exchange.body)) {
        flattened.push(...(exchange.body as ExtractArrayElement<T>[]));
      } else {
        flattened.push(exchange.body as ExtractArrayElement<T>);
      }
    }
    return {
      headers: exchanges[0].headers,
      body: flattened as FlattenedAggregateResult<T>,
    } as Exchange<FlattenedAggregateResult<T>>;
  }

  // No arrays found, return array of bodies (original behavior)
  return {
    headers: exchanges[0].headers,
    body: exchanges.map((x) => x.body) as FlattenedAggregateResult<T>,
  } as Exchange<FlattenedAggregateResult<T>>;
};

/**
 * Aggregator adapter: combines multiple exchanges (e.g. after a split) into one.
 * Used with `.aggregate()`. Default: collect bodies into an array (with one-level flattening).
 *
 * @template T - Body type of incoming exchanges
 * @template R - Result body type
 * @beta
 */
export interface Aggregator<T = unknown, R = unknown> extends Adapter {
  aggregate: CallableAggregator<T, R>;
}

/**
 * Step that aggregates exchanges from the same split group into a single exchange.
 * Uses the split hierarchy header to collect siblings; then runs the aggregator and continues with the result.
 */
export class AggregateStep<T = unknown, R = unknown> implements Step<
  Aggregator<T, R>
> {
  operation: OperationType = OperationType.AGGREGATE;
  adapter: Aggregator<T, R>;
  skipStepEvents = true;

  constructor(adapter: Aggregator<T, R> | CallableAggregator<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { aggregate: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const stepStartTime = Date.now();

    const splitHierarchy = exchange.headers[
      HeadersKeys.SPLIT_HIERARCHY
    ] as string[];
    const currentGroupId = splitHierarchy?.[splitHierarchy.length - 1];

    // Look up the parent exchange early so step events use its ID
    const parentMap = context?.getStore(SPLIT_PARENT_STORE) as
      | Map<string, Exchange>
      | undefined;
    const parentExchange = currentGroupId
      ? parentMap?.get(currentGroupId)
      : undefined;
    const stepExchangeId = parentExchange?.id ?? exchange.id;

    if (context) {
      context.emit(`route:${routeId}:step:started` as const, {
        routeId,
        exchangeId: stepExchangeId,
        correlationId,
        operation: this.operation,
      });
    }

    // If there's no split hierarchy, just aggregate the single exchange
    if (!splitHierarchy) {
      const aggregatedExchange = await Promise.resolve(
        this.adapter.aggregate([exchange]),
      );
      const next = DefaultExchange.rewrap<R>(exchange, {
        body: aggregatedExchange.body,
        headers: aggregatedExchange.headers,
      });

      if (context) {
        context.emit(`route:${routeId}:step:completed` as const, {
          routeId,
          exchangeId: next.id,
          correlationId: next.headers[HeadersKeys.CORRELATION_ID] as string,
          operation: this.operation,
          duration: Date.now() - stepStartTime,
          metadata: { inputCount: 1 },
        });
      }

      queue.push({
        exchange: next,
        steps: remainingSteps,
      });
      return;
    }

    const aggregationGroup: Exchange[] = [exchange];

    for (let i = 0; i < queue.length; ) {
      const item = queue[i];
      const itemHierarchy = item.exchange.headers[
        HeadersKeys.SPLIT_HIERARCHY
      ] as string[];
      if (itemHierarchy?.at(-1) === currentGroupId) {
        aggregationGroup.push(item.exchange);
        queue.splice(i, 1);
      } else {
        i++;
      }
    }

    // Emit exchange:completed for each child being aggregated
    if (context) {
      for (const child of aggregationGroup) {
        const childStart = getStartedAt(child) ?? Date.now();
        context.emit(`route:${routeId}:exchange:completed` as const, {
          routeId,
          exchangeId: child.id,
          correlationId: child.headers[HeadersKeys.CORRELATION_ID] as string,
          duration: Date.now() - childStart,
        });
      }
    }

    let aggregatedExchange: Exchange<R>;
    try {
      aggregatedExchange = await Promise.resolve(
        this.adapter.aggregate(aggregationGroup as Exchange<T>[]),
      );
    } finally {
      // Clean up the stored parent reference even on error
      if (currentGroupId) {
        parentMap?.delete(currentGroupId);
      }
    }

    // Restore the parent exchange identity by deriving from `parentExchange`
    // (or the current exchange when no parent was stashed). The new exchange
    // takes the aggregator's body / headers / principal but the parent's id
    // and internals (context, route binding) so post-aggregate telemetry
    // continues to reference the parent's lifecycle.
    const baseExchange = parentExchange ?? exchange;

    // Compute final headers: aggregator's headers minus the current split
    // group from the hierarchy (or strip the hierarchy entirely if this was
    // the outermost split).
    const remainingHierarchy = splitHierarchy.slice(0, -1);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
    const { [HeadersKeys.SPLIT_HIERARCHY]: _stripped, ...restHeaders } =
      aggregatedExchange.headers;
    const finalHeaders =
      remainingHierarchy.length > 0
        ? { ...restHeaders, [HeadersKeys.SPLIT_HIERARCHY]: remainingHierarchy }
        : restHeaders;

    const next = DefaultExchange.rewrap<R>(baseExchange, {
      body: aggregatedExchange.body,
      headers: finalHeaders,
    });

    if (context) {
      context.emit(`route:${routeId}:step:completed` as const, {
        routeId,
        exchangeId: next.id,
        correlationId: next.headers[HeadersKeys.CORRELATION_ID] as string,
        operation: this.operation,
        duration: Date.now() - stepStartTime,
        metadata: { inputCount: aggregationGroup.length },
      });
    }

    queue.push({
      exchange: next,
      steps: remainingSteps,
    });
  }
}
