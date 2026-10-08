import type { Exchange } from "../exchange.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import { type Duration, parseDuration } from "../shared/duration.ts";
import { stepPosition, stepPositionRun } from "./position-run.ts";
import type { Position } from "../kernel/positions.ts";

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
  duration: Duration,
): ResolvedTimeoutOptions {
  return { timeoutMs: parseDuration(duration, "timeout(duration)") };
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
  readonly #options: ResolvedTimeoutOptions;
  readonly #positions = new WeakMap<object, Position>();

  constructor(inner: Step<T>, duration: Duration) {
    super(inner);
    this.#options = resolveTimeoutOptions(duration);
  }

  protected override describeOptions(): unknown {
    return this.#options;
  }

  protected override runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const position = stepPosition(
      this.#positions,
      exchange,
      this,
      "timeout",
      (provider) => provider.timeout(this.#options),
    );
    return position.run(stepPositionRun(this, this.inner, exchange, ctx));
  }
}
