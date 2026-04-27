import type { Adapter, EventName, Step } from "../types.ts";
import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
} from "../exchange.ts";

/**
 * Outcome of {@link WrapperStep.runInner}. Subclasses use it to tell the
 * template method whether the inner step ran cleanly (`"ok"`) or threw
 * and was recovered by the wrapper (`"recovered"`). In both cases the
 * pipeline continues with `remainingSteps`.
 *
 * Subclasses signal a hard failure by throwing instead of returning;
 * the template method lets that propagate so `runSteps` cascades to the
 * route-level error handler (or the default `route:*:error` path when
 * none is set).
 *
 * @internal
 */
export type WrapperOutcome = "ok" | "recovered";

/**
 * Abstract base for "dual-mode wrapper" operations: a single concept
 * (`.error()`, future `.retry()`, `.timeout()`, `.cache()`, ...) that
 * applies at either route scope (when staged before `.from()`) or step
 * scope (when chained after `.from()`). The route-scope path is wired
 * by the builder via existing fields on `RouteDefinition`. The
 * step-scope path is wired by wrapping the *immediately next* step in a
 * concrete `WrapperStep` subclass.
 *
 * Subclasses implement {@link WrapperStep.runInner}: run the inner
 * step, decide whether to surface its result (`"ok"`), recover from a
 * failure (`"recovered"`), or rethrow (signals an unrecoverable error
 * for `runSteps` to handle).
 *
 * The template `execute()` handles the boilerplate: emitting the
 * inner step's `step:started` / `step:completed` events with the inner
 * label (so the wrapper is observationally invisible), then forwarding
 * `exchange` to the rest of the pipeline by pushing
 * `{ exchange, steps: remainingSteps }` onto the queue.
 *
 * @experimental Public surface is the dual-mode `.error()` builder
 * method (see {@link RouteBuilder.error}); the `WrapperStep` class is
 * exposed for forward-compat as wrapper authors land additional
 * operations (retry, cache, timeout, circuit breaker, etc.).
 */
export abstract class WrapperStep<
  T extends Adapter = Adapter,
> implements Step<T> {
  /**
   * Operation kind delegated from the inner step so observers see the
   * wrapped operation's identity, not a generic "wrapper".
   */
  readonly operation: Step<T>["operation"];
  /** Adapter delegated from the inner step. */
  readonly adapter: T;
  /** Display label delegated from the inner step. */
  readonly label?: string;
  /**
   * The wrapper emits its own `step:started` / `step:completed` events
   * with the inner step's label, so `runSteps` must not emit a generic
   * pair around the wrapper.
   */
  readonly skipStepEvents = true;

  constructor(protected readonly inner: Step<T>) {
    this.operation = inner.operation;
    this.adapter = inner.adapter;
    if (inner.label !== undefined) this.label = inner.label;
  }

  /**
   * Run the inner step with whatever extra behaviour the subclass adds.
   * Return `"ok"` when the inner step succeeded normally, or
   * `"recovered"` when the wrapper handled a failure and the pipeline
   * should continue with `exchange.body` set by the recovery path.
   * Throw to signal the wrapper could not recover; `runSteps` will then
   * fall through to the route-level error handler (or fail the
   * exchange when none is set).
   *
   * @param exchange Live exchange to feed to the inner step.
   * @returns Outcome that determines whether the pipeline continues.
   */
  protected abstract runInner(exchange: Exchange): Promise<WrapperOutcome>;

  /**
   * Template method called by `runSteps`. Emits the inner step's
   * lifecycle events with the inner label, delegates to
   * {@link runInner}, and forwards the exchange (or any child
   * exchanges the inner pushed) to the rest of the pipeline on
   * success or recovery. Wrapper-specific failure events are emitted
   * by the subclass before it rethrows.
   *
   * When the inner step pushes child exchanges (e.g. `split`), each
   * child is re-pushed onto the real queue with `remainingSteps`
   * appended so children continue through the rest of the pipeline.
   * When the inner step does not push (e.g. `to`, `transform`,
   * `process`), the wrapper pushes the mutated exchange itself.
   */
  async execute(
    exchange: Exchange,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    if (route && context) {
      const routeId = route.definition.id;
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
      });
    }

    const stepStart = Date.now();
    await this.runInner(exchange);

    if (route && context) {
      const routeId = route.definition.id;
      context.emit(`route:${routeId}:step:completed` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        duration: Date.now() - stepStart,
      });
    }

    // The subclass calls `inner.execute(exchange, [], innerQueue)` so
    // it can capture per-call outcome; relay any pushed children here
    // with `remainingSteps` reattached. When the inner step did not
    // push (the common case for transform / to / process / header /
    // tap / filter / validate), push the mutated exchange directly.
    const inner = this.drainInnerQueue();
    if (inner.length === 0) {
      queue.push({ exchange, steps: remainingSteps });
      return;
    }
    for (const item of inner) {
      queue.push({
        exchange: item.exchange,
        steps: [...item.steps, ...remainingSteps],
      });
    }
  }

  /**
   * Hand the inner queue captured by {@link runInner} back to the
   * template method. Subclasses that delegate to a private inner
   * queue must override this; the default returns an empty array,
   * which works for subclasses that pass the real queue to the inner
   * step directly.
   *
   * @internal
   */
  protected drainInnerQueue(): {
    exchange: Exchange;
    steps: Step<Adapter>[];
  }[] {
    return [];
  }
}
