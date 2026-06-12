import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { cancellableSleep, SleepAbortedError } from "./cancellable-sleep.ts";

/**
 * Options for the `.throttle()` wrapper (step scope and route scope).
 * Exactly one rate field must be supplied; the two are mutually
 * exclusive views of the same limit (`requestsPerMinute: 60` ===
 * `requestsPerSecond: 1`).
 */
export type ThrottleOptions =
  | { requestsPerSecond: number; requestsPerMinute?: never }
  | { requestsPerMinute: number; requestsPerSecond?: never };

/**
 * {@link ThrottleOptions} normalised to the two numbers the
 * {@link TokenBucket} needs. This is the shape staged on the builder's
 * pending options for route-scope `.throttle()`; the bucket itself is
 * built from it once per route.
 */
export interface ResolvedThrottleOptions {
  /**
   * Burst allowance: the most calls admitted back-to-back after an idle
   * window, before pacing kicks in. Set to the rate count (with a floor
   * of 1 so a sub-1 rate still admits the first call immediately).
   */
  capacity: number;
  /** Tokens replenished per millisecond (`rate / windowMs`). */
  refillPerMs: number;
}

/**
 * Validate user-supplied {@link ThrottleOptions} into a
 * {@link ResolvedThrottleOptions}. Rejects at build time when neither
 * or both rate fields are set, or the rate is not a positive finite
 * number, so a typo fails when the route is built rather than silently
 * never (or always) admitting at runtime.
 *
 * @internal
 */
export function resolveThrottleOptions(
  options: ThrottleOptions,
): ResolvedThrottleOptions {
  // Each union member declares the other field as optional `never`, so
  // both read directly as `number | undefined` without a cast.
  const perSecond = options.requestsPerSecond;
  const perMinute = options.requestsPerMinute;
  const hasSecond = perSecond !== undefined;
  const hasMinute = perMinute !== undefined;

  if (hasSecond === hasMinute) {
    throw rcError("RC5003", undefined, {
      message:
        "throttle() requires exactly one of { requestsPerSecond } or { requestsPerMinute }.",
    });
  }

  const rate = hasSecond ? (perSecond as number) : (perMinute as number);
  const field = hasSecond ? "requestsPerSecond" : "requestsPerMinute";
  if (!Number.isFinite(rate) || rate <= 0) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ ${field} }) must be a finite number > 0, got ${String(rate)}.`,
    });
  }

  const windowMs = hasSecond ? 1000 : 60_000;
  return {
    capacity: Math.max(1, rate),
    refillPerMs: rate / windowMs,
  };
}

/**
 * Lazy-refill token bucket. Holds the rate-limiter state SHARED across
 * every exchange on a route: one bucket per route (per `.throttle()`),
 * never one per exchange. `reserve()` is synchronous, so under the
 * single-threaded event loop a batch of concurrent exchanges each takes
 * a distinct slot in the same tick and their waits stack deterministically
 * (FIFO-fair, never exceeding the configured rate).
 *
 * Tokens are allowed to go negative: a caller that finds the bucket
 * empty still decrements, which reserves a slot further in the future
 * for the next caller. That is what makes concurrent waits queue
 * instead of all racing for the same single token.
 *
 * @internal
 */
export class TokenBucket {
  #tokens: number;
  #lastRefillAt: number;
  readonly #capacity: number;
  readonly #refillPerMs: number;

  constructor(
    { capacity, refillPerMs }: ResolvedThrottleOptions,
    now: number = Date.now(),
  ) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerMs;
    // Start full so the first burst (up to `capacity`) is admitted
    // without an initial wait.
    this.#tokens = capacity;
    this.#lastRefillAt = now;
  }

  /**
   * Reserve one token for the calling exchange and return how long it
   * must wait (ms) before that token is available. `0` means a token
   * was free immediately.
   */
  reserve(now: number = Date.now()): number {
    const elapsed = now - this.#lastRefillAt;
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + elapsed * this.#refillPerMs,
    );
    this.#lastRefillAt = now;

    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }

    // Empty (or already over-committed): take this token from the
    // future. The deficit to the next whole token decides the wait, and
    // going negative parks the following caller one slot further out.
    const deficit = 1 - this.#tokens;
    const waitMs = deficit / this.#refillPerMs;
    this.#tokens -= 1;
    return waitMs;
  }
}

/**
 * Lifecycle hooks the throttle gate reports to, so the step-scope
 * wrapper and the route-scope filter emit the same `route:throttle:*`
 * events with their own `scope` / `stepLabel` bindings.
 *
 * @internal
 */
export interface ThrottleHooks {
  /** Route abort signal; cancels the pacing wait on shutdown. */
  signal?: AbortSignal;
  /** A token was not free; the exchange will wait `waitMs` before admission. */
  onDelayed(waitMs: number): void;
  /**
   * The exchange is admitted. `waited` is true when it had to pace;
   * `elapsed` is the total time spent in the gate.
   */
  onPassed(waited: boolean, elapsed: number): void;
}

/**
 * Acquire a slot from the shared {@link TokenBucket}, pacing the caller
 * when the bucket is empty. Shared by the step-scope wrapper and the
 * route-scope filter.
 *
 * The pacing wait is cancellable: when the route shuts down mid-wait the
 * exchange is admitted immediately rather than dropped, mirroring
 * `.delay()`. Rate limiting only ever delays an exchange; it never drops
 * one.
 *
 * @internal
 */
export async function acquireThrottleSlot(
  bucket: TokenBucket,
  hooks: ThrottleHooks,
): Promise<void> {
  const start = Date.now();
  const waitMs = bucket.reserve(start);
  if (waitMs <= 0) {
    hooks.onPassed(false, 0);
    return;
  }
  hooks.onDelayed(waitMs);
  try {
    await cancellableSleep(waitMs, hooks.signal);
  } catch (err) {
    if (!(err instanceof SleepAbortedError)) throw err;
    // Route shutdown: stop pacing and admit the exchange so teardown
    // does not silently drop it.
  }
  hooks.onPassed(true, Date.now() - start);
}

/**
 * Step-scope `.throttle()` wrapper. Rate-limits the wrapped step to a
 * fixed number of calls per time window, pacing exchanges that exceed
 * the rate (backpressure) rather than dropping them.
 *
 * The {@link TokenBucket} is route-level shared state: the builder
 * constructs ONE wrapper instance per route at build time, so every
 * exchange on the route shares this bucket. This is the deliberate
 * exception to the `WrapperStep` rule against storing state on `this`:
 * that rule bars PER-EXECUTION state (which would leak across
 * exchanges); a rate limiter's bucket is PER-ROUTE state and sharing it
 * is the entire point. See `.standards/resilience-wrappers.md` section 8.
 *
 * Emits scope-aware lifecycle events:
 * - `route:throttle:delayed` when an exchange must wait for a token.
 * - `route:throttle:passed` when an exchange is admitted (with `waited`).
 */
export class ThrottleWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #bucket: TokenBucket;

  constructor(inner: Step<T>, options: ThrottleOptions) {
    super(inner);
    this.#bucket = new TokenBucket(resolveThrottleOptions(options));
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

    await acquireThrottleSlot(this.#bucket, {
      ...(route ? { signal: route.signal } : {}),
      onDelayed: (waitMs) => {
        if (shouldEmit) {
          context.emit("route:throttle:delayed", { ...scoped, waitMs });
        }
      },
      onPassed: (waited, elapsed) => {
        if (shouldEmit) {
          context.emit("route:throttle:passed", {
            ...scoped,
            waited,
            elapsed,
          });
        }
      },
    });

    return await this.inner.execute(exchange, ctx);
  }
}
