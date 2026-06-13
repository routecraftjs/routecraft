import { LRUCache } from "lru-cache";
import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { Route } from "../route.ts";
import { WrapperStep } from "./wrapper.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { cancellableSleep, SleepAbortedError } from "./cancellable-sleep.ts";

/**
 * Time window a `.throttle()` rate is measured over.
 *
 * Longer quota windows (week / month) are intentionally absent: this is
 * an IN-MEMORY limiter, so its state resets on process restart and is
 * not shared across instances. That is fine for second-to-day smoothing
 * but unsafe for a durable "N per month" quota, which needs persistent,
 * shared storage (a separate feature).
 */
export type ThrottleTimeUnit = "second" | "minute" | "hour" | "day";

const WINDOW_MS: Record<ThrottleTimeUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * `setTimeout`'s maximum delay; a larger value is coerced to ~1ms and
 * fires immediately. The pacing wait is clamped to this so an extreme
 * backlog still waits (rather than being admitted instantly, which would
 * break the rate guarantee precisely under heavy backpressure).
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Default cap on distinct keys tracked when `key` is set. */
const DEFAULT_MAX_KEYS = 10_000;

/**
 * Options for the `.throttle()` wrapper (step scope and route scope).
 */
export interface ThrottleOptions {
  /** Allowed requests per `per` window. Must be a finite number > 0. */
  rate: number;
  /** Time window the `rate` is measured over. Default `"second"`. */
  per?: ThrottleTimeUnit;
  /**
   * Burst allowance: the most calls admitted back-to-back after an idle
   * window before pacing kicks in (the token bucket's capacity). Default
   * is `rate` (one window's worth). Set it lower for stricter pacing, or
   * higher to tolerate spikes. Decoupled from `per`, so `{ rate: 600,
   * per: "minute" }` does not silently allow a 600-wide burst unless you
   * ask for it.
   */
  burst?: number;
  /**
   * Partition the limit: each distinct key gets its own independent
   * bucket, so you can rate-limit per user, per IP, per tenant, etc.
   * Omit for a single bucket shared across the whole route (a global
   * limit). The selector runs once per exchange.
   *
   * @example Per authenticated principal
   * ```ts
   * .throttle({ rate: 10, key: (ex) => ex.principal?.sub ?? "anonymous" })
   * ```
   */
  key?: (exchange: Exchange) => string;
  /**
   * Maximum number of distinct keys to track concurrently when `key` is
   * set. The per-key buckets live in an LRU, so memory stays bounded
   * even with an unbounded key space (the least-recently-used key's
   * bucket is evicted and resets when it next appears). Default
   * `10_000`. Ignored when `key` is not set.
   */
  maxKeys?: number;
}

/**
 * {@link ThrottleOptions} normalised to what the limiter needs. Staged
 * on the builder's pending options for route-scope `.throttle()`.
 *
 * @internal
 */
export interface ResolvedThrottleOptions {
  /** Token bucket capacity (burst allowance). */
  capacity: number;
  /** Tokens replenished per millisecond (`rate / windowMs`). */
  refillPerMs: number;
  /** Per-exchange partition selector; absent means a single shared bucket. */
  key?: (exchange: Exchange) => string;
  /** LRU cap on distinct keys (only meaningful when `key` is set). */
  maxKeys: number;
}

/**
 * Validate user-supplied {@link ThrottleOptions} into a
 * {@link ResolvedThrottleOptions}. Rejects at build time so a typo fails
 * when the route is built rather than silently never (or always)
 * admitting at runtime.
 *
 * @internal
 */
export function resolveThrottleOptions(
  options: ThrottleOptions,
): ResolvedThrottleOptions {
  const {
    rate,
    per = "second",
    burst,
    key,
    maxKeys = DEFAULT_MAX_KEYS,
  } = options;

  if (!Number.isFinite(rate) || rate <= 0) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ rate }) must be a finite number > 0, got ${String(rate)}.`,
    });
  }
  if (!(per in WINDOW_MS)) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ per }) must be one of "second", "minute", "hour", got ${String(per)}.`,
    });
  }
  if (burst !== undefined && (!Number.isFinite(burst) || burst <= 0)) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ burst }) must be a finite number > 0, got ${String(burst)}.`,
    });
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ maxKeys }) must be an integer >= 1, got ${String(maxKeys)}.`,
    });
  }

  return {
    // Floor an absent burst at 1 so a sub-1 rate still admits the first
    // call immediately; an explicit burst is honoured as given.
    capacity: burst ?? Math.max(1, rate),
    refillPerMs: rate / WINDOW_MS[per],
    ...(key ? { key } : {}),
    maxKeys,
  };
}

/**
 * Lazy-refill token bucket. `reserve()` is synchronous, so under the
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
   * must wait (ms) before that token is available. `0` means a token was
   * free immediately.
   */
  reserve(now: number = Date.now()): number {
    // Clamp at 0: a backward wall-clock step (NTP / DST / manual) must
    // not subtract tokens, which would over-pace the next callers.
    const elapsed = Math.max(0, now - this.#lastRefillAt);
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + elapsed * this.#refillPerMs,
    );
    this.#lastRefillAt = now;

    // Decrement once, then derive the wait from any resulting deficit.
    this.#tokens -= 1;
    if (this.#tokens >= 0) return 0;
    const waitMs = -this.#tokens / this.#refillPerMs;
    // Cap at the timer ceiling so a huge backlog still waits instead of
    // being coerced to ~1ms by setTimeout and admitted immediately.
    return Math.min(waitMs, MAX_TIMER_MS);
  }
}

/**
 * Per-route rate-limiter state for one `.throttle()`. Holds a single
 * shared {@link TokenBucket} when unkeyed, or an LRU of per-key buckets
 * when a `key` selector is configured. One instance per Route (see
 * {@link ThrottleController}), never one per exchange.
 *
 * @internal
 */
export class ThrottleLimiter {
  readonly #options: ResolvedThrottleOptions;
  #single?: TokenBucket;
  readonly #keyed?: LRUCache<string, TokenBucket>;

  constructor(options: ResolvedThrottleOptions) {
    this.#options = options;
    if (options.key) {
      // Idle keys are dropped once their bucket would have fully
      // refilled: a full bucket is indistinguishable from a fresh one,
      // so eviction is lossless and a returning key just rebuilds an
      // identical full bucket. `ttl` = refill-to-full time;
      // `updateAgeOnGet` makes it "idle since last use". `max` is the
      // hard ceiling for a flood of distinct keys WITHIN one ttl window
      // (e.g. random-IP abuse), so memory stays bounded regardless.
      const ttl = Math.max(
        1,
        Math.ceil(options.capacity / options.refillPerMs),
      );
      this.#keyed = new LRUCache<string, TokenBucket>({
        max: options.maxKeys,
        ttl,
        updateAgeOnGet: true,
      });
    }
  }

  /**
   * Reserve a slot for `exchange`, returning the wait (ms) and the
   * partition key it was charged against (absent when unkeyed).
   */
  reserve(exchange: Exchange, now: number): { waitMs: number; key?: string } {
    if (!this.#options.key) {
      this.#single ??= new TokenBucket(this.#options, now);
      return { waitMs: this.#single.reserve(now) };
    }
    const key = this.#options.key(exchange);
    let bucket = this.#keyed!.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.#options, now);
      this.#keyed!.set(key, bucket);
    }
    return { waitMs: bucket.reserve(now), key };
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
  onDelayed(waitMs: number, key?: string): void;
  /**
   * The exchange is admitted. `waited` is true when it had to pace;
   * `elapsed` is the total time spent in the gate; `key` is the partition
   * it was charged against (absent when unkeyed).
   */
  onPassed(waited: boolean, elapsed: number, key?: string): void;
}

/**
 * Owns the rate-limiter state for one `.throttle()` across every Route
 * the enclosing step runs in. Keyed by Route in a WeakMap, so a single
 * step instance or gate closure shared by a `RouteDefinition` registered
 * into multiple contexts gives each Route its OWN limiter rather than
 * one shared bucket (which would let the contexts cross-rate-limit).
 *
 * @internal
 */
export class ThrottleController {
  readonly #options: ResolvedThrottleOptions;
  readonly #byRoute = new WeakMap<Route, ThrottleLimiter>();
  #routeless?: ThrottleLimiter;

  constructor(options: ResolvedThrottleOptions) {
    this.#options = options;
  }

  #limiterFor(route: Route | undefined): ThrottleLimiter {
    if (!route) {
      // No attached route (e.g. a step run in isolation): fall back to a
      // single process-local limiter so behaviour is still bounded.
      this.#routeless ??= new ThrottleLimiter(this.#options);
      return this.#routeless;
    }
    let limiter = this.#byRoute.get(route);
    if (!limiter) {
      limiter = new ThrottleLimiter(this.#options);
      this.#byRoute.set(route, limiter);
    }
    return limiter;
  }

  /**
   * Acquire a slot, pacing the caller when the bucket is empty. The
   * pacing wait is cancellable: when the route shuts down mid-wait the
   * exchange is admitted immediately rather than dropped, mirroring
   * `.delay()`. Rate limiting only ever delays an exchange; it never
   * drops one.
   */
  async acquire(
    exchange: Exchange,
    route: Route | undefined,
    hooks: ThrottleHooks,
  ): Promise<void> {
    const start = Date.now();
    const { waitMs, key } = this.#limiterFor(route).reserve(exchange, start);
    if (waitMs <= 0) {
      hooks.onPassed(false, 0, key);
      return;
    }
    hooks.onDelayed(waitMs, key);
    try {
      await cancellableSleep(waitMs, hooks.signal);
    } catch (err) {
      if (!(err instanceof SleepAbortedError)) throw err;
      // Route shutdown: stop pacing and admit the exchange so teardown
      // does not silently drop it.
    }
    hooks.onPassed(true, Date.now() - start, key);
  }
}

/**
 * Step-scope `.throttle()` wrapper. Rate-limits the wrapped step to a
 * fixed number of calls per time window, pacing exchanges that exceed
 * the rate (backpressure) rather than dropping them.
 *
 * The limiter state lives on a {@link ThrottleController} held on the
 * wrapper instance. The builder constructs one wrapper instance per
 * route at build time, but the controller keys its buckets by Route, so
 * every exchange on a given Route shares one limiter while distinct
 * Routes (even built from the same definition) stay isolated. This is
 * the deliberate exception to the `WrapperStep` rule against storing
 * state on `this`: that rule bars PER-EXECUTION state; a rate limiter is
 * PER-ROUTE state and sharing it is the entire point. See
 * `.standards/resilience-wrappers.md` section 8.
 *
 * Emits scope-aware lifecycle events:
 * - `route:throttle:delayed` when an exchange must wait for a token.
 * - `route:throttle:passed` when an exchange is admitted (with `waited`).
 */
export class ThrottleWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #controller: ThrottleController;

  constructor(inner: Step<T>, options: ThrottleOptions) {
    super(inner);
    this.#controller = new ThrottleController(resolveThrottleOptions(options));
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

    await this.#controller.acquire(exchange, route, {
      ...(route ? { signal: route.signal } : {}),
      onDelayed: (waitMs, key) => {
        if (shouldEmit) {
          context.emit("route:throttle:delayed", {
            ...scoped,
            waitMs,
            ...(key !== undefined ? { key } : {}),
          });
        }
      },
      onPassed: (waited, elapsed, key) => {
        if (shouldEmit) {
          context.emit("route:throttle:passed", {
            ...scoped,
            waited,
            elapsed,
            ...(key !== undefined ? { key } : {}),
          });
        }
      },
    });

    return await this.inner.execute(exchange, ctx);
  }
}
