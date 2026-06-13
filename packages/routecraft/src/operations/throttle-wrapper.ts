import { LRUCache } from "lru-cache";
import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { CraftContext } from "../context.ts";
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
 * Hard ceiling on `maxKeys`. The per-key LRU pre-allocates index arrays
 * sized to its `max`, so this bounds the eager allocation a single
 * `.throttle({ key })` can trigger and stops an absurd value from OOMing
 * the process at build time.
 */
const MAX_KEYS_CEILING = 1_000_000;

/**
 * Options for the `.throttle()` wrapper (step scope and route scope).
 */
export interface ThrottleOptions {
  /** Allowed requests per `per` window. Must be a finite number > 0. */
  rate: number;
  /** Time window the `rate` is measured over. Default `"second"`. */
  per?: ThrottleTimeUnit;
  /**
   * Behaviour when an exchange exceeds the rate:
   * - `"delay"` (default): pace it, waiting until a token frees. Smooths
   *   bursty traffic into a steady rate; never drops an exchange.
   * - `"reject"`: throw `RC5013` immediately so the caller fails fast
   *   (e.g. a source returns 429) instead of being buffered. Avoids the
   *   unbounded in-flight growth that delay can accumulate under a fast
   *   source. A rejected exchange does NOT consume a token.
   */
  mode?: "delay" | "reject";
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
   * limit). The selector runs once per exchange and MUST return a
   * string; coalesce missing values (e.g. `?? "anonymous"`). A selector
   * that throws fails the exchange (it is user code, like a transform),
   * so guard it rather than relying on the never-drops contract.
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
  /**
   * Optional label carried on this throttle's `route:throttle:*` events,
   * so stacked gates (e.g. a global limit plus a per-IP limit) can be
   * told apart in logs and metrics. Has no effect on behaviour.
   */
  label?: string;
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
  /** On-limit behaviour. */
  mode: "delay" | "reject";
  /** Per-exchange partition selector; absent means a single shared bucket. */
  key?: (exchange: Exchange) => string;
  /** LRU cap on distinct keys (only meaningful when `key` is set). */
  maxKeys: number;
  /** Optional label for `route:throttle:*` events. */
  label?: string;
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
    mode = "delay",
    burst,
    key,
    maxKeys = DEFAULT_MAX_KEYS,
    label,
  } = options;

  if (mode !== "delay" && mode !== "reject") {
    throw rcError("RC5003", undefined, {
      message: `throttle({ mode }) must be "delay" or "reject", got ${String(mode)}.`,
    });
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ rate }) must be a finite number > 0, got ${String(rate)}.`,
    });
  }
  if (!(per in WINDOW_MS)) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ per }) must be one of ${Object.keys(WINDOW_MS)
        .map((u) => `"${u}"`)
        .join(", ")}, got ${String(per)}.`,
    });
  }
  if (burst !== undefined && (!Number.isFinite(burst) || burst <= 0)) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ burst }) must be a finite number > 0, got ${String(burst)}.`,
    });
  }
  // Upper-bound `maxKeys`: the per-key LRU pre-allocates index arrays
  // sized to `max` at construction, so an "effectively unlimited" value
  // would OOM the process the moment the limiter is built, not gradually.
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_KEYS_CEILING) {
    throw rcError("RC5003", undefined, {
      message: `throttle({ maxKeys }) must be an integer between 1 and ${MAX_KEYS_CEILING}, got ${String(maxKeys)}.`,
    });
  }

  return {
    // Capacity floors at 1 so a sub-1 rate (or an accidental sub-1
    // `burst`) still admits the first call immediately instead of pacing
    // every exchange.
    capacity: Math.max(1, burst ?? rate),
    refillPerMs: rate / WINDOW_MS[per],
    mode,
    ...(key ? { key } : {}),
    maxKeys,
    ...(label !== undefined ? { label } : {}),
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

  /**
   * Reject-mode acquire: take a token only if one is available right now.
   * Returns `0` when admitted; otherwise the time (ms) until a token
   * would free, WITHOUT consuming one (a rejected request must not drive
   * the bucket negative or it would penalise later conforming calls).
   */
  tryAcquire(now: number = Date.now()): number {
    const elapsed = Math.max(0, now - this.#lastRefillAt);
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + elapsed * this.#refillPerMs,
    );
    this.#lastRefillAt = now;

    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return (1 - this.#tokens) / this.#refillPerMs;
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
      // Idle keys are dropped once their bucket would have refilled to
      // full: a full bucket is indistinguishable from a fresh one, so a
      // returning key just rebuilds an identical full bucket. `ttl` =
      // refill-to-full FROM EMPTY; `updateAgeOnGet` makes it "idle since
      // last use". A bucket driven negative (heavy backlog) needs longer
      // than `ttl` to truly reach full, so evicting it at `ttl` can
      // forgive a little unpaid debt and grant the returning key an early
      // burst -- a bounded, self-correcting over-admit at the eviction
      // boundary, accepted as the price of cheap memory reclamation.
      // `max` is the hard ceiling for a flood of distinct keys WITHIN one
      // ttl window (e.g. random-IP abuse), so memory stays bounded.
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
   * Resolve the {@link TokenBucket} for `exchange` (the shared one, or
   * the per-key one, creating it on first use), plus the partition key it
   * belongs to (absent when unkeyed). The caller decides whether to
   * `reserve` (delay) or `tryAcquire` (reject) against it.
   */
  bucketFor(
    exchange: Exchange,
    now: number,
  ): { bucket: TokenBucket; key?: string } {
    if (!this.#options.key) {
      this.#single ??= new TokenBucket(this.#options, now);
      return { bucket: this.#single };
    }
    let key: string;
    try {
      key = this.#options.key(exchange);
    } catch (err) {
      // The selector is user code; surface a clear, actionable error
      // rather than a generic step failure. Throttle's "only ever
      // delays" contract covers the rate mechanism, not a throwing key
      // selector (use a fallback such as `?? "anonymous"`).
      throw rcError("RC5003", err, {
        message:
          'throttle({ key }) selector threw; it must return a string for every exchange (e.g. coalesce a missing value with `?? "anonymous"`).',
      });
    }
    let bucket = this.#keyed!.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.#options, now);
      this.#keyed!.set(key, bucket);
    }
    return { bucket, key };
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
  /**
   * Reject-mode only: the exchange exceeded the rate and is being failed.
   * `retryAfterMs` is how long until a token would free.
   */
  onRejected(retryAfterMs: number, key?: string): void;
}

/** Event-scope bindings shared by the `route:throttle:*` payloads. */
export interface ThrottleEventScope {
  routeId: string;
  exchangeId: string;
  correlationId: string;
  stepLabel: string;
  scope: "route" | "step";
  /** Optional gate label, when configured. */
  label?: string;
}

/**
 * Build the `onDelayed` / `onPassed` half of {@link ThrottleHooks} that
 * emits the `route:throttle:*` events. Shared by the step-scope wrapper
 * and the route-scope gate so the event payload shape lives in one place
 * (only the `scoped` descriptor and the `emit` guard differ between
 * them). `context?.emit` no-ops when the exchange carries no context.
 *
 * @internal
 */
export function throttleEmitHooks(
  context: CraftContext | undefined,
  scoped: ThrottleEventScope,
  emit: boolean,
): Pick<ThrottleHooks, "onDelayed" | "onPassed" | "onRejected"> {
  return {
    onDelayed: (waitMs, key) => {
      if (emit) {
        context?.emit("route:throttle:delayed", {
          ...scoped,
          waitMs,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
    onPassed: (waited, elapsed, key) => {
      if (emit) {
        context?.emit("route:throttle:passed", {
          ...scoped,
          waited,
          elapsed,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
    onRejected: (retryAfterMs, key) => {
      if (emit) {
        context?.emit("route:throttle:rejected", {
          ...scoped,
          retryAfterMs,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
  };
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

  /** Optional gate label, surfaced on the `route:throttle:*` events. */
  get label(): string | undefined {
    return this.#options.label;
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
   * Acquire a slot. In `delay` mode (default) the caller is paced when
   * the bucket is empty; the pacing wait is cancellable, so on route
   * shutdown the exchange is admitted rather than dropped. In `reject`
   * mode an over-limit exchange is failed fast with `RC5013` (and a
   * `route:throttle:rejected` event) without consuming a token.
   */
  async acquire(
    exchange: Exchange,
    route: Route | undefined,
    hooks: ThrottleHooks,
  ): Promise<void> {
    const start = Date.now();
    const { bucket, key } = this.#limiterFor(route).bucketFor(exchange, start);

    if (this.#options.mode === "reject") {
      const retryAfterMs = bucket.tryAcquire(start);
      if (retryAfterMs <= 0) {
        hooks.onPassed(false, 0, key);
        return;
      }
      hooks.onRejected(retryAfterMs, key);
      throw rcError("RC5013", undefined, {
        message: `throttle rejected the exchange: rate limit exceeded${
          key !== undefined ? ` for key "${key}"` : ""
        }. Retry after ~${Math.ceil(retryAfterMs)}ms.`,
      });
    }

    const waitMs = bucket.reserve(start);
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
    const scoped: ThrottleEventScope = {
      routeId: routeId as string,
      exchangeId: exchange.id,
      correlationId,
      stepLabel,
      scope: "step",
      ...(this.#controller.label !== undefined
        ? { label: this.#controller.label }
        : {}),
    };

    await this.#controller.acquire(exchange, route, {
      ...(route ? { signal: route.signal } : {}),
      ...throttleEmitHooks(context, scoped, Boolean(shouldEmit)),
    });

    return await this.inner.execute(exchange, ctx);
  }
}
