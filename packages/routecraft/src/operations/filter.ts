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
 * Returned by a filter predicate to drop an exchange with a reason.
 * The reason is recorded in telemetry and shown in the TUI.
 */
export interface FilterDropResult {
  reason: string;
}

/**
 * Predicate over the full exchange. Return `true` to keep the exchange,
 * `false` to drop it, or `{ reason: "..." }` to drop with an explanation.
 *
 * @template T - Body type of the exchange
 *
 * @example
 * ```ts
 * .filter((ex) => {
 *   if (!ex.body.name) return { reason: "name is required" };
 *   if (ex.body.age < 18) return { reason: "age must be 18 or older" };
 *   return true;
 * })
 * ```
 */
export type CallableFilter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<boolean | FilterDropResult> | boolean | FilterDropResult;

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
  label?: string;
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
    const stepLabel = this.label ?? this.operation;

    // Emit step:started
    if (context) {
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });
    }

    try {
      const result = await Promise.resolve(this.adapter.filter(exchange));

      // Determine if the exchange should be dropped and extract the reason.
      const dropReason = isFilterDrop(result)
        ? result.reason
        : result
          ? undefined
          : "filtered";

      if (dropReason !== undefined) {
        exchange.logger.debug(
          {
            operation: stepLabel,
            reason: dropReason,
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
            operation: stepLabel,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            duration: Date.now() - stepStart,
          });

          context.emit(`route:${routeId}:exchange:dropped` as EventName, {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            reason: dropReason,
            exchange,
          });
        }
        // Mark the exchange as dropped so the route engine does not emit
        // exchange:completed for it after runSteps finishes.
        exchange.headers["routecraft.dropped"] = true;
        return;
      }
    } catch (error: unknown) {
      if (context) {
        context.emit(`route:${routeId}:step:failed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          duration: Date.now() - stepStart,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
      });
    }

    queue.push({ exchange, steps: remainingSteps });
  }
}

/**
 * Type guard for a {@link FilterDropResult} returned by a filter predicate.
 */
function isFilterDrop(
  value: boolean | FilterDropResult,
): value is FilterDropResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FilterDropResult).reason === "string"
  );
}
