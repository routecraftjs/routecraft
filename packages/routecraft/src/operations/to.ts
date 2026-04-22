import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  OperationType,
  getExchangeContext,
} from "../exchange.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";

/**
 * Function form of a destination: receives the exchange and optionally returns a new body.
 * Use with `.to(destination)` or adapters that implement Destination.
 *
 * - Return `undefined` (or void) to leave the exchange body unchanged.
 * - Return a value to replace `exchange.body` with that value (e.g. API response).
 *
 * @template T - Current body type
 * @template R - Result body type (default void = no body change)
 */
export type CallableDestination<T = unknown, R = void> = (
  exchange: Exchange<T>,
) => Promise<R> | R;

/**
 * Destination adapter: sends the exchange to an external system (e.g. HTTP, queue, DB).
 * Used with `.to()`, `.tap()`, or `.enrich()`. If `send` returns a value, the body is replaced.
 *
 * @template T - Current body type
 * @template R - Result body type (void = no body change)
 */
export interface Destination<T = unknown, R = void> extends Adapter {
  send: CallableDestination<T, R>;
}

/**
 * Step that sends the exchange to a destination. If the destination returns a value, the body is replaced with it; otherwise the body is unchanged.
 */
export class ToStep<T = unknown, R = void> implements Step<Destination<T, R>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T, R>;
  metadata?: Record<string, unknown>;

  constructor(adapter: Destination<T, R> | CallableDestination<T, R>) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    // Resolve a test-time override (if any) registered on the context.
    // When present, the mock handler stands in for adapter.send; if the mock
    // has no handler, the call is silently swallowed (a noop destination).
    const override = resolveAdapterOverride(
      this.adapter,
      getExchangeContext(exchange),
    );

    let result: unknown;
    if (override) {
      result = await invokeSendOverride(
        exchange,
        this.adapter as unknown as Destination<unknown, unknown>,
        override,
      );
    } else {
      result = await Promise.resolve(this.adapter.send(exchange));
    }

    // Extract metadata if the adapter provides it (skip when overridden; mock
    // results are typically primitives and have no adapter metadata).
    const getMetadata = (
      this.adapter as {
        getMetadata?: (result: unknown) => Record<string, unknown>;
      }
    ).getMetadata;
    if (!override && getMetadata) {
      this.metadata = getMetadata.call(this.adapter, result);
    }

    // If result is defined, replace body with result
    if (result !== undefined) {
      exchange.body = result as T;
    }

    // Push the exchange to the queue
    queue.push({ exchange, steps: remainingSteps });
  }
}
