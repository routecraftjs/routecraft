import type { Adapter, EventName, Step } from "../types.ts";
import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  OperationType,
} from "../exchange.ts";
import { rcError } from "../error.ts";

/**
 * Operation kinds that resilience wrappers cannot safely wrap. Validated
 * at construction time by {@link WrapperStep} so misuse fails when the
 * route is built, not at first dispatch.
 *
 * - `aggregate`: reads sibling exchanges from the shared route queue
 *   via `queue.splice(...)`. The wrapper hands inner an isolated
 *   per-execution buffer, so an aggregator inside a wrapper would only
 *   ever see the current exchange.
 * - `split`: emits children synchronously then may throw mid-stream;
 *   recovery would silently truncate already-emitted children. Wrap
 *   the steps DOWNSTREAM of `.split()` instead.
 *
 * @internal
 */
const NON_WRAPPABLE_OPERATIONS: ReadonlySet<OperationType> = new Set([
  OperationType.AGGREGATE,
  OperationType.SPLIT,
]);

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
    if (NON_WRAPPABLE_OPERATIONS.has(inner.operation)) {
      throw rcError("RC5003", undefined, {
        message:
          `Wrapper operations (e.g. .error(), future .retry() / .timeout() / .cache()) cannot wrap "${inner.operation}" steps. ` +
          `Aggregate reads siblings from the shared route queue and split emits children synchronously; both have semantics ` +
          `that conflict with per-execution wrapper isolation. Wrap the steps downstream of split / before aggregate instead.`,
      });
    }
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
   * `innerQueue` is a per-execution buffer the subclass passes to
   * `inner.execute(exchange, [], innerQueue)`. Any items the inner
   * step pushes (e.g. `split` children) are captured here; the
   * template method then re-relays them to the real queue with
   * `remainingSteps` reattached. The buffer is local to a single
   * `execute()` call, so the same step instance can serve concurrent
   * exchanges without state leakage. Subclasses must clear the buffer
   * on a recovered failure to avoid leaking the failed inner's
   * partial pushes into the recovered path.
   *
   * @param exchange Live exchange to feed to the inner step.
   * @param innerQueue Per-execution buffer for inner-pushed children.
   * @returns Outcome that determines whether the pipeline continues.
   */
  protected abstract runInner(
    exchange: Exchange,
    innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<WrapperOutcome>;

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
    const routeId = route?.definition.id;
    // The wrapper only emits step lifecycle events when the inner
    // step does NOT manage its own. Steps with `skipStepEvents = true`
    // (filter, choice, split, aggregate, choice's halt, child
    // wrappers in a stack) emit their own pair, so the wrapper must
    // stay silent to avoid duplicates.
    const innerOwnsEvents = this.inner.skipStepEvents === true;
    const shouldEmitEvents = !innerOwnsEvents && route && context && routeId;

    if (shouldEmitEvents) {
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
      });
    }

    const stepStart = Date.now();
    // Per-execution buffer; passed to runInner so concurrent
    // exchanges flowing through the same step instance don't share
    // state.
    const innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];
    try {
      await this.runInner(exchange, innerQueue);
    } catch (err) {
      // Emit step:failed before propagating so observers see a
      // balanced started → failed pair. This matters for stacked
      // wrappers where an inner wrapper threw and an outer wrapper
      // recovers; without this, the inner wrapper's started event
      // would never have a closing event.
      if (shouldEmitEvents) {
        context.emit(`route:${routeId}:step:failed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          duration: Date.now() - stepStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }

    if (shouldEmitEvents) {
      context.emit(`route:${routeId}:step:completed` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        duration: Date.now() - stepStart,
      });
    }

    // Relay any children the inner step pushed (e.g. `split` children
    // when the wrapper is downstream of one) with `remainingSteps`
    // reattached. When the inner step did not push:
    // - If the inner intentionally dropped the exchange (filter
    //   reject, choice unmatched, halt all set `routecraft.dropped`),
    //   leave it dropped. Re-pushing would resurrect the drop and run
    //   subsequent steps on a logically-removed exchange.
    // - Otherwise push the mutated exchange so the rest of the
    //   pipeline runs (the common case for transform / to / process /
    //   header / tap / validate).
    if (innerQueue.length === 0) {
      if (exchange.headers["routecraft.dropped"] === true) return;
      queue.push({ exchange, steps: remainingSteps });
      return;
    }
    for (const item of innerQueue) {
      queue.push({
        exchange: item.exchange,
        steps: [...item.steps, ...remainingSteps],
      });
    }
  }
}
