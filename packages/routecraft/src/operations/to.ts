import {
  type Adapter,
  type Step,
  type StepOutcome,
  extractOutcomeMetadata,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  getExchangeContext,
  DefaultExchange,
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
 * The body type that flows downstream from a `.to()` step.
 *
 * Destinations declared with `R = void` (the default) leave the body
 * untouched, so the queued exchange stays `Exchange<T>`. A destination
 * that returns a meaningful `R` replaces the body, so the queued
 * exchange becomes `Exchange<R>`. The `Extract<R, void>` distinction
 * (rather than `[R] extends [void]`) handles unions that include `void`:
 * for `R = string | void`, the result is `T | string` (the `void`
 * branch contributes the original `T`, the `string` branch contributes
 * the new body), instead of letting the `void` leak through into a
 * downstream `Exchange<string | void>`.
 */
type ToResultBody<T, R> = [Extract<R, void>] extends [never]
  ? R
  : T | Exclude<R, void>;

/**
 * Step that sends the exchange to a destination. If the destination returns a value, the body is replaced with it; otherwise the body is unchanged.
 */
export class ToStep<T = unknown, R = void> implements Step<Destination<T, R>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T, R>;

  constructor(adapter: Destination<T, R> | CallableDestination<T, R>) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
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

    // The metadata rides the OUTCOME, not the step: Step instances are
    // shared across exchanges.
    const metadata = extractOutcomeMetadata(this.adapter, result, !!override);

    // If result is defined, replace body with result via a derived
    // exchange (the original is frozen; constructing a new wrapper preserves
    // identity and internals via rewrap). The next exchange is typed
    // `Exchange<ToResultBody<T, R>>` so a non-void destination return
    // type flows through to subsequent steps instead of being silently
    // widened to `T`.
    const next: Exchange<ToResultBody<T, R>> =
      result !== undefined
        ? DefaultExchange.rewrap<ToResultBody<T, R>>(exchange, {
            body: result as ToResultBody<T, R>,
          })
        : (exchange as Exchange<ToResultBody<T, R>>);

    return {
      kind: "continue",
      exchange: next,
      ...(metadata ? { metadata } : {}),
    };
  }
}
