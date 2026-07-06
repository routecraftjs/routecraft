import type { Exchange } from "../exchange.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import { assertDurationMs } from "./cancellable-sleep.ts";

/**
 * Route-scope `.timeout()` config. This is the shape stored on
 * `RouteDefinition.timeout` (and is therefore part of the public
 * definition surface); the builder stages it pre-`.from()` and the
 * pipeline executor's timeout segment consumes it.
 */
export interface ResolvedTimeoutOptions {
  /** Deadline in milliseconds for each run of the bounded segment. */
  timeoutMs: number;
}

/**
 * Validate a user-supplied timeout into a {@link ResolvedTimeoutOptions}.
 * Shared by the step-scope wrapper constructor and the builder's
 * route-scope staging so both fail fast on a non-finite or
 * non-positive deadline (a `setTimeout(NaN)` would otherwise expire
 * instantly at runtime).
 *
 * @internal
 */
export function resolveTimeoutOptions(
  timeoutMs: number,
): ResolvedTimeoutOptions {
  assertDurationMs("timeout(timeoutMs)", timeoutMs, 1);
  return { timeoutMs };
}

/**
 * Sentinel error rejected by the deadline arm of
 * {@link raceWithDeadline}. Callers map it to the public `RC5011`
 * timeout error; it never escapes the framework.
 *
 * @internal
 */
export class DeadlineExceededError extends Error {
  constructor() {
    super("routecraft.timeout.deadline");
    this.name = "DeadlineExceededError";
  }
}

/**
 * Race `run` against a `timeoutMs` deadline. Resolves with the run's
 * value when it settles in time; rejects with
 * {@link DeadlineExceededError} when the deadline fires first. The
 * deadline timer is cleared in all cases so no timer outlives the
 * race.
 *
 * JavaScript promises cannot be cancelled: when the deadline wins, the
 * losing run keeps executing in the background. Its eventual
 * settlement is swallowed here so it cannot surface as an unhandled
 * rejection. Side effects of the abandoned run still happen; the
 * timeout bounds how long the pipeline waits, not the work itself.
 *
 * Shared by the step-scope `.timeout()` wrapper and the route-scope
 * timeout segment in the pipeline executor.
 *
 * @internal
 */
export async function raceWithDeadline<R>(
  run: Promise<R>,
  timeoutMs: number,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError()), timeoutMs);
  });
  try {
    return await Promise.race([run, deadline]);
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      run.catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step-scope `.timeout()` wrapper. Bounds the wrapped step with a
 * deadline: when the step settles in time its outcome passes through
 * unchanged; when the deadline fires first the wrapper throws `RC5011`
 * (Request timeout, `retryable: true`) so an outer `.retry()` wrapper
 * re-attempts it by default and `.error()` handlers can branch on the
 * code.
 *
 * The wrapped step's promise is not cancelled on expiry (promises
 * cannot be cancelled): its eventual settlement is discarded. What the
 * step DOES get is an `AbortSignal` on its `StepContext` that fires
 * when the deadline expires, with the `RC5011` error as the abort
 * reason. A step that forwards `ctx.signal` into cancellation-aware IO
 * (`fetch`, DB drivers) therefore aborts its abandoned work instead of
 * running it to completion in the background. The signal is linked to
 * any enclosing signal (a route-scope timeout's abandon signal, an
 * outer step-scope timeout), so whichever deadline fires first aborts
 * the innermost work.
 *
 * Emits scope-aware lifecycle events:
 * - `route:timeout:started` when the guarded execution begins.
 * - `route:timeout:stopped` when the step settles within the deadline.
 * - `route:timeout:expired` when the deadline fires (then throws).
 */
export class TimeoutWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #timeoutMs: number;

  constructor(inner: Step<T>, timeoutMs: number) {
    super(inner);
    this.#timeoutMs = resolveTimeoutOptions(timeoutMs).timeoutMs;
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { route, context, routeId, stepLabel, correlationId } =
      wrapperEventScope(exchange, this);
    const shouldEmit = route && context && routeId;

    if (shouldEmit) {
      context.emit("route:timeout:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        timeoutMs: this.#timeoutMs,
      });
    }

    // Per-execution controller: aborts when THIS deadline expires so the
    // inner step can cancel in-flight IO. Linked to any enclosing signal
    // (route-scope abandon, outer step-scope timeout) via AbortSignal.any
    // so the earliest deadline wins; the composed signal replaces
    // `ctx.signal` for the inner step only, every other StepContext
    // capability passes through untouched.
    const controller = new AbortController();
    const innerCtx: StepContext = {
      ...ctx,
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal,
    };

    const start = Date.now();
    try {
      const outcome = await raceWithDeadline(
        this.inner.execute(exchange, innerCtx),
        this.#timeoutMs,
      );
      if (shouldEmit) {
        context.emit("route:timeout:stopped", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          timeoutMs: this.#timeoutMs,
          elapsed: Date.now() - start,
        });
      }
      return outcome;
    } catch (err) {
      if (!(err instanceof DeadlineExceededError)) throw err;
      const timeoutError = rcError("RC5011", undefined, {
        message: `Step "${stepLabel}" exceeded its ${this.#timeoutMs}ms timeout`,
      });
      // Abort BEFORE emitting so cancellation-aware IO in the abandoned
      // run stops as early as possible; the reason surfaces as the
      // rejection of any fetch()/driver call holding the signal.
      controller.abort(timeoutError);
      if (shouldEmit) {
        context.emit("route:timeout:expired", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          timeoutMs: this.#timeoutMs,
          elapsed: Date.now() - start,
        });
      }
      throw timeoutError;
    }
  }
}
