import type {
  Adapter,
  EventName,
  Step,
  StepContext,
  StepOutcome,
} from "../types.ts";
import { getAdapterLabel } from "../types.ts";
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
 * - `aggregate`: a join point that consumes pending sibling exchanges
 *   via the executor's `takePending` capability. That shared pending
 *   state cannot be isolated per wrapper execution, so retry/recovery
 *   semantics around it are undefined. Wrap the steps UPSTREAM of
 *   `.aggregate()` instead.
 * - `split`: emits children via a `fanOut` outcome. A recovering
 *   wrapper would have to convert a fan-out failure into a single
 *   recovered exchange, silently changing the pipeline's cardinality.
 *   Wrap the steps DOWNSTREAM of `.split()` instead.
 *
 * @internal
 */
const NON_WRAPPABLE_OPERATIONS: ReadonlySet<OperationType> = new Set([
  OperationType.AGGREGATE,
  OperationType.SPLIT,
]);

/**
 * Abstract base for "dual-mode wrapper" operations: a single concept
 * (`.error()`, future `.retry()`, `.timeout()`, `.cache()`, ...) that
 * applies at either route scope (when staged before `.from()`) or step
 * scope (when chained after `.from()`). The route-scope path is wired
 * by the builder via existing fields on `RouteDefinition`. The
 * step-scope path is wired by wrapping the *immediately next* step in a
 * concrete `WrapperStep` subclass.
 *
 * Subclasses implement {@link WrapperStep.runInner}: run the inner step
 * and return its {@link StepOutcome} (usually unchanged), substitute a
 * recovery outcome on failure, or rethrow (signals an unrecoverable
 * error for the pipeline executor to handle).
 *
 * The template `execute()` handles the boilerplate: emitting the
 * inner step's `step:started` / `step:completed` events with the inner
 * label (so the wrapper is observationally invisible) around the
 * subclass's `runInner`, and passing the inner's outcome through to the
 * executor, which owns all scheduling.
 *
 * The `WrapperStep` class is exposed for forward-compat as wrapper
 * authors land additional operations (retry, cache, timeout, circuit
 * breaker, etc.).
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
   * with the inner step's label, so the executor must not emit a generic
   * pair around the wrapper.
   */
  readonly skipStepEvents = true;

  constructor(protected readonly inner: Step<T>) {
    if (NON_WRAPPABLE_OPERATIONS.has(inner.operation)) {
      throw rcError("RC5003", undefined, {
        message:
          `Wrapper operations (e.g. .error(), future .retry() / .timeout() / .cache()) cannot wrap "${inner.operation}" steps. ` +
          `Aggregate consumes pending siblings (shared join state) and split fans out children; both have semantics ` +
          `that conflict with per-execution wrapper recovery. Wrap the steps downstream of split / upstream of aggregate instead.`,
      });
    }
    this.operation = inner.operation;
    this.adapter = inner.adapter;
    if (inner.label !== undefined) this.label = inner.label;
  }

  /**
   * Run the inner step with whatever extra behaviour the subclass adds
   * and return the outcome the pipeline should act on. Return the
   * inner's outcome unchanged when it succeeded; return a substitute
   * outcome (e.g. `continue` with a recovered exchange) when the
   * wrapper handled a failure. Throw to signal the wrapper could not
   * recover; the executor will then fall through to the route-level
   * error handler (or fail the exchange when none is set).
   *
   * There is no scheduling to intercept: the inner step never sees the
   * work queue, so a failed inner step has, by construction, scheduled
   * nothing. The pre-outcome engine required subclasses to capture and
   * replay inner queue pushes (and clear them on recovery); that whole
   * protocol is gone.
   *
   * @param exchange Live exchange to feed to the inner step.
   * @param ctx Executor capability passthrough for the inner step.
   * @returns Outcome the executor schedules.
   */
  protected abstract runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome>;

  /**
   * Template method called by the pipeline executor. Emits the inner
   * step's lifecycle events with the inner label, delegates to
   * {@link runInner}, and returns the outcome for the executor to
   * schedule. Wrapper-specific failure events are emitted by the
   * subclass before it rethrows.
   */
  async execute(exchange: Exchange, ctx: StepContext): Promise<StepOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const stepLabel = this.label ?? String(this.operation);
    const adapterLabel = getAdapterLabel(this.adapter);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const routeId = route?.definition.id;
    // The wrapper only emits step lifecycle events when the inner
    // step does NOT manage its own. Steps with `skipStepEvents = true`
    // (filter, choice, choice's halt, child wrappers in a stack) emit
    // their own pair, so the wrapper must stay silent to avoid
    // duplicates.
    const innerOwnsEvents = this.inner.skipStepEvents === true;
    const shouldEmitEvents = !innerOwnsEvents && route && context && routeId;

    if (shouldEmitEvents) {
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });
    }

    const stepStart = Date.now();
    let outcome: StepOutcome;
    try {
      outcome = await this.runInner(exchange, ctx);
    } catch (err) {
      // Emit step:failed before propagating so observers see a
      // balanced started -> failed pair. This matters for stacked
      // wrappers where an inner wrapper threw and an outer wrapper
      // recovers; without this, the inner wrapper's started event
      // would never have a closing event.
      if (shouldEmitEvents) {
        context.emit(`route:${routeId}:step:failed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
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
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
      });
    }

    return outcome;
  }
}
