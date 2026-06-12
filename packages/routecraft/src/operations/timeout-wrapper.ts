import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";

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
 * The wrapped step is not cancelled on expiry (promises cannot be
 * cancelled); it keeps running in the background and its eventual
 * settlement is discarded. Side effects of the abandoned attempt may
 * still happen.
 *
 * Emits scope-aware lifecycle events:
 * - `route:timeout:started` when the guarded execution begins.
 * - `route:timeout:stopped` when the step settles within the deadline.
 * - `route:timeout:expired` when the deadline fires (then throws).
 */
export class TimeoutWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  constructor(
    inner: Step<T>,
    private readonly timeoutMs: number,
  ) {
    super(inner);
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const routeId = route?.definition.id;
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const shouldEmit = route && context && routeId;

    if (shouldEmit) {
      context.emit("route:timeout:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        timeoutMs: this.timeoutMs,
      });
    }

    const start = Date.now();
    try {
      const outcome = await raceWithDeadline(
        this.inner.execute(exchange, ctx),
        this.timeoutMs,
      );
      if (shouldEmit) {
        context.emit("route:timeout:stopped", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          timeoutMs: this.timeoutMs,
          elapsed: Date.now() - start,
        });
      }
      return outcome;
    } catch (err) {
      if (!(err instanceof DeadlineExceededError)) throw err;
      if (shouldEmit) {
        context.emit("route:timeout:expired", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel,
          scope: "step",
          timeoutMs: this.timeoutMs,
          elapsed: Date.now() - start,
        });
      }
      throw rcError("RC5011", undefined, {
        message: `Step "${stepLabel}" exceeded its ${this.timeoutMs}ms timeout`,
      });
    }
  }
}
