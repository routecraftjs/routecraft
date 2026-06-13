import { type Exchange } from "../exchange.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import {
  assertDurationMs,
  cancellableSleep,
  SleepAbortedError,
} from "./cancellable-sleep.ts";

/**
 * Options for the `.retry()` wrapper (step scope and route scope).
 */
export interface RetryOptions {
  /**
   * Maximum total attempts, including the first one. `3` means the
   * original execution plus up to two re-attempts. Must be at least 1.
   * Default: `3`.
   */
  maxAttempts?: number;
  /**
   * Base wait between attempts in milliseconds. Default: `1000`.
   */
  backoffMs?: number;
  /**
   * When `true`, the wait doubles per attempt:
   * `backoffMs * 2^(attempt - 1)`. Default: `false` (fixed backoff).
   */
  exponential?: boolean;
  /**
   * Decide whether a failed attempt is re-attempted. Default: skip
   * `RoutecraftError`s with `retryable: false` (validation, auth,
   * config errors fail the same way every time); everything else,
   * including unknown third-party errors, is retried.
   */
  retryOn?: (error: Error) => boolean;
}

/**
 * {@link RetryOptions} with every field populated. This is the shape
 * stored on `RouteDefinition.retry` for route-scope `.retry()` (and is
 * therefore part of the public definition surface); internally it is
 * shared between the step-scope wrapper and the route-scope segment
 * step in the pipeline executor.
 */
export interface ResolvedRetryOptions {
  maxAttempts: number;
  backoffMs: number;
  exponential: boolean;
  retryOn: (error: Error) => boolean;
}

/**
 * Default `retryOn` predicate: a `RoutecraftError` registered (or
 * overridden) as `retryable: false` is not re-attempted; every other
 * error is. Unknown third-party errors are retried (optimistic
 * default).
 *
 * @internal
 */
export function defaultRetryOn(error: Error): boolean {
  if (isRoutecraftError(error)) {
    return (error as RoutecraftError).retryable !== false;
  }
  return true;
}

/**
 * Resolve user-supplied {@link RetryOptions} into a fully populated
 * {@link ResolvedRetryOptions}, validating `maxAttempts`.
 *
 * @internal
 */
export function resolveRetryOptions(
  options: RetryOptions = {},
): ResolvedRetryOptions {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw rcError("RC5003", undefined, {
      message: `retry({ maxAttempts }) must be an integer >= 1, got ${String(maxAttempts)}.`,
    });
  }
  const backoffMs = options.backoffMs ?? 1000;
  assertDurationMs("retry({ backoffMs })", backoffMs, 0);
  return {
    maxAttempts,
    backoffMs,
    exponential: options.exponential ?? false,
    retryOn: options.retryOn ?? defaultRetryOn,
  };
}

/**
 * Lifecycle hooks the retry loop reports to, so the step-scope wrapper
 * and the route-scope segment step emit the same `route:retry:*`
 * events with their own `scope` / `stepLabel` bindings.
 *
 * @internal
 */
export interface RetryHooks {
  /** Route abort signal; cancels the backoff wait on shutdown. */
  signal?: AbortSignal;
  onStarted(): void;
  /**
   * A failed attempt will be re-attempted after `waitMs`. `lastError`
   * is the raw thrown value (matching the event payload's `unknown`),
   * not the Error normalised for the `retryOn` check.
   */
  onAttempt(attemptNumber: number, waitMs: number, lastError: unknown): void;
  /** Final outcome. `error` is the final raw thrown value on failure. */
  onStopped(attemptNumber: number, success: boolean, error?: unknown): void;
}

/**
 * The retry loop shared by the step-scope wrapper and the route-scope
 * segment step. Runs `attempt` up to `options.maxAttempts` times,
 * waiting the (optionally exponential) backoff between attempts.
 *
 * - A non-retryable error (per `retryOn`) propagates immediately.
 * - When the route shuts down during a backoff wait, the loop gives up
 *   and propagates the last real error rather than waiting out the
 *   backoff or burning further attempts during teardown.
 * - After the final attempt fails, the final error propagates
 *   unchanged so route-level `.error()` handlers see the real cause.
 *
 * @internal
 */
export async function executeWithRetry<R>(
  attempt: () => Promise<R>,
  options: ResolvedRetryOptions,
  hooks: RetryHooks,
): Promise<R> {
  hooks.onStarted();
  // Unbounded loop on purpose: every iteration either returns or
  // throws once `attemptNumber` reaches `maxAttempts` (validated >= 1
  // by resolveRetryOptions), and an explicit bound would leave dead
  // code after the loop to satisfy control-flow analysis.
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      const result = await attempt();
      hooks.onStopped(attemptNumber, true);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (attemptNumber >= options.maxAttempts || !options.retryOn(error)) {
        hooks.onStopped(attemptNumber, false, err);
        throw err;
      }
      // Clamp to the platform timer ceiling (2^31 - 1 ms): past it,
      // setTimeout coerces the delay (Node clamps to 1ms, so a huge
      // exponential wait would fire instantly) and 2 ** n overflows to
      // Infinity around attempt 1024. Unreachable for sane configs.
      const waitMs = options.exponential
        ? Math.min(options.backoffMs * 2 ** (attemptNumber - 1), 2_147_483_647)
        : options.backoffMs;
      hooks.onAttempt(attemptNumber, waitMs, err);
      try {
        await cancellableSleep(waitMs, hooks.signal);
      } catch (sleepErr) {
        if (!(sleepErr instanceof SleepAbortedError)) throw sleepErr;
        // Shutdown during backoff: surface the last real failure
        // instead of attempting work on a stopping route.
        hooks.onStopped(attemptNumber, false, err);
        throw err;
      }
    }
  }
}

/**
 * Step-scope `.retry()` wrapper. Re-attempts the wrapped step on
 * failure with configurable backoff. Each attempt receives the same
 * (frozen) exchange, so a re-attempt always starts from the input that
 * failed, not from partial output.
 *
 * The attempt counter is loop-local state inside one execution; it is
 * NOT written to exchange headers (headers carry persistent exchange
 * state, see `.standards/exchange-state-model.md`). Observers track
 * attempts via the `route:retry:attempt` events instead.
 *
 * Emits the pre-declared scope-aware lifecycle events:
 * - `route:retry:started` when the guarded execution begins.
 * - `route:retry:attempt` before each backoff wait + re-attempt.
 * - `route:retry:stopped` on final success or failure.
 */
export class RetryWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #options: ResolvedRetryOptions;

  constructor(inner: Step<T>, options: RetryOptions = {}) {
    super(inner);
    this.#options = resolveRetryOptions(options);
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { route, context, routeId, stepLabel, correlationId } =
      wrapperEventScope(exchange, this);
    const shouldEmit = route && context && routeId;
    const scoped = {
      routeId: routeId as string,
      exchangeId: exchange.id,
      correlationId,
      stepLabel,
      scope: "step" as const,
    };

    return await executeWithRetry(
      () => this.inner.execute(exchange, ctx),
      this.#options,
      {
        ...(route ? { signal: route.signal } : {}),
        onStarted: () => {
          if (shouldEmit) {
            context.emit("route:retry:started", {
              ...scoped,
              maxAttempts: this.#options.maxAttempts,
            });
          }
        },
        onAttempt: (attemptNumber, waitMs, lastError) => {
          if (shouldEmit) {
            context.emit("route:retry:attempt", {
              ...scoped,
              attemptNumber,
              maxAttempts: this.#options.maxAttempts,
              backoffMs: waitMs,
              lastError,
            });
          }
        },
        onStopped: (attemptNumber, success, error) => {
          if (shouldEmit) {
            context.emit("route:retry:stopped", {
              ...scoped,
              attemptNumber,
              success,
              ...(error !== undefined ? { error } : {}),
            });
          }
        },
      },
    );
  }
}
