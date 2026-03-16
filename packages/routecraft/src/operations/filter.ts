import {
  type Adapter,
  type Step,
  getAdapterLabel,
  type EventName,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";

/**
 * Predicate over the full exchange. Return true to keep the exchange, false to drop it.
 * Use with `.filter(predicate)`. Can inspect headers, body, and other exchange fields.
 *
 * @template T - Body type of the exchange
 */
export type CallableFilter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<boolean> | boolean;

/**
 * Filter adapter: keeps or drops the exchange based on a predicate. Used with `.filter()`.
 *
 * @template T - Body type
 */
export interface Filter<T = unknown> extends Adapter {
  filter: CallableFilter<T>;
}

/**
 * Step that runs a predicate on the exchange. If the predicate returns false, the exchange is dropped (no further steps).
 * If it throws, the error is wrapped as RC5001.
 */
export class FilterStep<T = unknown> implements Step<Filter<T>> {
  operation: OperationType = OperationType.FILTER;
  adapter: Filter<T>;
  skipStepEvents = true;

  constructor(adapter: Filter<T> | CallableFilter<T>) {
    this.adapter =
      typeof adapter === "function" ? { filter: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const adapterLabel = getAdapterLabel(this.adapter);
    const stepStart = Date.now();

    // Emit step:started
    if (context) {
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });
    }

    try {
      const result = await Promise.resolve(this.adapter.filter(exchange));
      if (!result) {
        exchange.logger.debug(
          {
            operation: "filter",
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
          },
          "Filter rejected exchange",
        );

        if (context) {
          // Emit step:completed first, then exchange:dropped
          context.emit(`route:${routeId}:step:completed` as EventName, {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            operation: this.operation,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            duration: Date.now() - stepStart,
          });

          context.emit(`route:${routeId}:exchange:dropped` as EventName, {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            reason: "filtered",
          });
        }
        return;
      }
    } catch (error: unknown) {
      throw rcError("RC5001", error, {
        message: "Filter predicate threw",
      });
    }

    // Emit step:completed for passed exchanges
    if (context) {
      context.emit(`route:${routeId}:step:completed` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
      });
    }

    queue.push({ exchange, steps: remainingSteps });
  }
}
