import { randomUUID } from "node:crypto";
import { type Adapter, type Step, getAdapterLabel } from "../types.ts";
import { INTERNALS_KEY } from "../brand.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
  EXCHANGE_INTERNALS,
} from "../exchange.ts";
import type { Route } from "../route.ts";

/**
 * Store key for the map of split group IDs to their parent exchanges.
 * Used by the aggregate step to restore the parent exchange identity
 * after merging children.
 */
export const SPLIT_PARENT_STORE = "routecraft.split.parents" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [SPLIT_PARENT_STORE]: Map<string, Exchange>;
  }
}

/**
 * Function form of a splitter: takes the current exchange and returns an array of exchanges.
 * Use with `.split(splitter)` or no-arg `.split()` for arrays. The framework overlays
 * `routecraft.split_hierarchy` and assigns new ids for aggregation.
 *
 * @template T - Current body type
 * @template R - Body type of each returned exchange
 */
export type CallableSplitter<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>[]> | Exchange<R>[];

/**
 * Splitter adapter: turns one body into many; each item is processed as a separate exchange.
 * Used with `.split()`. Default (no adapter): array bodies are split into elements; non-arrays become one item.
 *
 * @template T - Current body type
 * @template R - Item type
 */
export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split: CallableSplitter<T, R>;
}

/**
 * Step that splits the exchange into multiple exchanges (e.g. one per array element).
 * Each new exchange gets a new id and shared split hierarchy for aggregation.
 * Framework maintains `routecraft.split_hierarchy` headers for aggregation.
 */
export class SplitStep<T = unknown, R = unknown> implements Step<
  Splitter<T, R>
> {
  operation: OperationType = OperationType.SPLIT;
  adapter: Splitter<T, R>;
  skipStepEvents = true;

  constructor(adapter: Splitter<T, R> | CallableSplitter<T, R>) {
    this.adapter = typeof adapter === "function" ? { split: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);

    if (!context) {
      throw new Error("Exchange has no context; cannot execute split");
    }

    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const adapterLabel = getAdapterLabel(this.adapter);
    const stepStart = Date.now();

    context.emit(`route:${routeId}:step:started` as const, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: this.operation,
      ...(adapterLabel ? { adapter: adapterLabel } : {}),
    });

    let splitExchanges: Exchange<R>[];
    try {
      splitExchanges = await Promise.resolve(this.adapter.split(exchange));
    } catch (error: unknown) {
      context.emit(`route:${routeId}:step:failed` as const, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const groupId = randomUUID();

    // Stash the parent exchange so aggregate can restore it
    let parentMap = context.getStore(SPLIT_PARENT_STORE) as
      | Map<string, Exchange>
      | undefined;
    if (!parentMap) {
      parentMap = new Map<string, Exchange>();
      context.setStore(SPLIT_PARENT_STORE, parentMap);
    }
    parentMap.set(groupId, exchange);

    const existingHierarchy =
      (exchange.headers[HeadersKeys.SPLIT_HIERARCHY] as string[]) || [];
    const splitHierarchy = [...existingHierarchy, groupId];

    for (const resultExchange of splitExchanges) {
      const postProcessedExchange = new DefaultExchange<R>(context, {
        id: randomUUID(),
        body: resultExchange.body,
        headers: {
          ...resultExchange.headers,
          [HeadersKeys.SPLIT_HIERARCHY]: splitHierarchy,
        },
      });

      // Set route in internals if it exists (symbol-key for cross-instance)
      if (route) {
        const internals =
          (
            postProcessedExchange as Exchange & {
              [key: symbol]: { context: unknown; route?: Route };
            }
          )[INTERNALS_KEY] ?? EXCHANGE_INTERNALS.get(postProcessedExchange);
        if (internals) {
          internals.route = route as Route;
        }
      }

      const adapterLabel = getAdapterLabel(this.adapter);
      postProcessedExchange.logger.debug(
        {
          operation: "split",
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          splitHierarchy:
            postProcessedExchange.headers[HeadersKeys.SPLIT_HIERARCHY],
        },
        "Pushing split exchange to queue",
      );
      queue.push({
        exchange: postProcessedExchange,
        steps: remainingSteps,
      });
    }

    context.emit(`route:${routeId}:step:completed` as const, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: this.operation,
      ...(adapterLabel ? { adapter: adapterLabel } : {}),
      duration: Date.now() - stepStart,
      metadata: { childCount: splitExchanges.length },
    });
  }
}
