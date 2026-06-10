import {
  type Adapter,
  type Step,
  getAdapterLabel,
  type StepOutcome,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  markDropped,
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

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
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
      context.emit("route:step:started", {
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

        // Mark the exchange as dropped before emitting `exchange:dropped`
        // so a subscriber that calls `isDropped(event.details.exchange)`
        // observes the correct state. The drop flag lives on the
        // exchange's shared internals object (see `markDropped` /
        // `isDropped` in `exchange.ts`); the route engine reads it
        // after `runPipeline` to skip `exchange:completed`.
        markDropped(exchange);

        if (context) {
          // Emit step:completed first, then exchange:dropped
          context.emit("route:step:completed", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            operation: stepLabel,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            duration: Date.now() - stepStart,
          });

          context.emit("route:exchange:dropped", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            reason: dropReason,
            exchange,
          });
        }
        return { kind: "drop" };
      }
    } catch (error: unknown) {
      if (context) {
        context.emit("route:step:failed", {
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
      context.emit("route:step:completed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
      });
    }

    return { kind: "continue", exchange };
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
