import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";

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
      ...exchanges[0],
      body: flattened as FlattenedAggregateResult<T>,
    };
  }

  // No arrays found, return array of bodies (original behavior)
  return {
    ...exchanges[0],
    body: exchanges.map((x) => x.body) as FlattenedAggregateResult<T>,
  };
};

/**
 * Aggregator adapter: combines multiple exchanges (e.g. after a split) into one.
 * Used with `.aggregate()`. Default: collect bodies into an array (with one-level flattening).
 *
 * @template T - Body type of incoming exchanges
 * @template R - Result body type
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

    // Emit aggregate:started event
    if (context) {
      context.emit(`route:${routeId}:operation:aggregate:started` as const, {
        routeId,
        exchangeId: exchange.id,
        correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
      });
    }

    const splitHierarchy = exchange.headers[
      HeadersKeys.SPLIT_HIERARCHY
    ] as string[];

    // If there's no split hierarchy, just aggregate the single exchange
    if (!splitHierarchy) {
      const aggregatedExchange = await Promise.resolve(
        this.adapter.aggregate([exchange]),
      );
      // Copy aggregated properties back to original exchange
      exchange.body = aggregatedExchange.body as unknown as T;
      (exchange as { headers: ExchangeHeaders }).headers =
        aggregatedExchange.headers;

      // Emit aggregate:stopped event
      if (context) {
        context.emit(`route:${routeId}:operation:aggregate:stopped` as const, {
          routeId,
          exchangeId: exchange.id,
          correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
          inputCount: 1,
        });
      }

      queue.push({
        exchange: exchange as unknown as Exchange<R>,
        steps: remainingSteps,
      });
      return;
    }

    const currentGroupId = splitHierarchy[splitHierarchy.length - 1];
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

    const aggregatedExchange = await Promise.resolve(
      this.adapter.aggregate(aggregationGroup as Exchange<T>[]),
    );

    // Copy aggregated properties back to original exchange
    exchange.body = aggregatedExchange.body as unknown as T;
    (exchange as { headers: ExchangeHeaders }).headers =
      aggregatedExchange.headers;

    // Remove the current group from hierarchy after aggregation
    const remainingHierarchy = splitHierarchy.slice(0, -1);
    if (remainingHierarchy.length > 0) {
      (exchange.headers as ExchangeHeaders)[HeadersKeys.SPLIT_HIERARCHY] =
        remainingHierarchy;
    } else {
      delete (exchange.headers as ExchangeHeaders)[HeadersKeys.SPLIT_HIERARCHY];
    }

    // Emit aggregate:stopped event
    if (context) {
      context.emit(`route:${routeId}:operation:aggregate:stopped` as const, {
        routeId,
        exchangeId: exchange.id,
        correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
        inputCount: aggregationGroup.length,
      });
    }

    queue.push({
      exchange: exchange as unknown as Exchange<R>,
      steps: remainingSteps,
    });
  }
}
