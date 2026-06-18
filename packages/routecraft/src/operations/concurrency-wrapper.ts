import { LRUCache } from "lru-cache";
import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { CraftContext } from "../context.ts";
import type { Route } from "../route.ts";
import { WrapperStep } from "./wrapper.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { SleepAbortedError } from "./cancellable-sleep.ts";
import { DEFAULT_MAX_KEYS, validateMaxKeys } from "./max-keys.ts";
import { RouteScopedController } from "./route-scoped-controller.ts";
import { Semaphore } from "./semaphore.ts";

/**
 * Options for the `.concurrency()` wrapper (step scope and route scope).
 *
 * A bulkhead: it bounds how many exchanges run the wrapped work AT ONCE,
 * as opposed to `.throttle()`, which bounds how many run PER TIME WINDOW.
 * The two compose but are not substitutes: a 10/sec throttle still allows
 * unbounded simultaneous in-flight exchanges if each is slow; a
 * concurrency of 5 caps simultaneity regardless of rate (protect a
 * connection pool, a memory-bound step, or a downstream with a hard
 * concurrency cap).
 */
export interface ConcurrencyOptions {
  /** Maximum simultaneous in-flight exchanges. Must be a finite integer >= 1. */
  max: number;
  /**
   * Behaviour when all slots are busy:
   * - `"queue"` (default): the exchange waits FIFO for a slot, applying
   *   backpressure rather than dropping it. The wait is cancellable, so on
   *   route shutdown a waiting exchange is admitted rather than stranded.
   * - `"reject"`: fail fast with `RC5026` (no slot, no wait) so the caller
   *   sheds load instead of building an unbounded in-memory backlog.
   */
  mode?: "queue" | "reject";
  /**
   * Queue mode only: cap the wait line. When `max` slots are busy AND
   * `maxQueue` exchanges are already waiting, the next one fails fast with
   * `RC5026` instead of joining the queue. The middle ground between "wait
   * forever" (omit it) and "reject as soon as busy" (`mode: "reject"`).
   * Must be a finite integer >= 1; passing it in `reject` mode is rejected
   * at build time (use `mode: "reject"`, which is `maxQueue: 0`). Default:
   * unbounded.
   */
  maxQueue?: number;
  /**
   * Partition the limit: each distinct key gets its own independent slot
   * pool, so you can cap concurrency per user / tenant / connection pool.
   * Omit for a single pool shared across the whole route. The selector runs
   * once per exchange and MUST return a string; coalesce missing values
   * (e.g. `?? "anonymous"`). A selector that throws fails the exchange.
   *
   * @example Per authenticated principal
   * ```ts
   * .concurrency({ max: 3, key: (ex) => ex.principal?.sub ?? "anonymous" })
   * ```
   */
  key?: (exchange: Exchange) => string;
  /**
   * Maximum number of distinct keys to track concurrently when `key` is
   * set. Per-key semaphores live in an LRU, so memory stays bounded even
   * with an unbounded key space. Default `10_000`. Ignored when `key` is
   * not set.
   */
  maxKeys?: number;
  /**
   * Optional label carried on this bulkhead's `route:concurrency:*` events,
   * so stacked or sibling limiters can be told apart in logs and metrics.
   * Has no effect on behaviour.
   */
  label?: string;
}

/**
 * {@link ConcurrencyOptions} with every behavioural field populated. Shared
 * by the step-scope wrapper and the route-scope segment.
 *
 * @internal
 */
export interface ResolvedConcurrencyOptions {
  max: number;
  mode: "queue" | "reject";
  /** Wait-queue bound; `Number.POSITIVE_INFINITY` when unbounded. */
  maxQueue: number;
  key?: (exchange: Exchange) => string;
  maxKeys: number;
  label?: string;
}

/**
 * Validate user-supplied {@link ConcurrencyOptions} into a
 * {@link ResolvedConcurrencyOptions}. Rejects at build time (RC5003) so a
 * typo fails when the route is built rather than at first dispatch.
 *
 * @internal
 */
export function resolveConcurrencyOptions(
  options: ConcurrencyOptions,
): ResolvedConcurrencyOptions {
  const {
    max,
    mode = "queue",
    maxQueue,
    key,
    maxKeys = DEFAULT_MAX_KEYS,
    label,
  } = options;

  if (!Number.isInteger(max) || max < 1) {
    throw rcError("RC5003", undefined, {
      message: `concurrency({ max }) must be an integer >= 1, got ${String(max)}.`,
    });
  }
  if (mode !== "queue" && mode !== "reject") {
    throw rcError("RC5003", undefined, {
      message: `concurrency({ mode }) must be "queue" or "reject", got ${String(mode)}.`,
    });
  }
  if (maxQueue !== undefined) {
    if (mode === "reject") {
      throw rcError("RC5003", undefined, {
        message:
          'concurrency({ maxQueue }) is meaningless in reject mode (reject never queues). Drop maxQueue, or use mode "queue".',
      });
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw rcError("RC5003", undefined, {
        message: `concurrency({ maxQueue }) must be an integer >= 1, got ${String(maxQueue)}. To fail fast when all slots are busy, use mode "reject".`,
      });
    }
  }
  validateMaxKeys("concurrency", maxKeys);

  return {
    max,
    mode,
    maxQueue: maxQueue ?? Number.POSITIVE_INFINITY,
    ...(key ? { key } : {}),
    maxKeys,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Per-route bulkhead state for one `.concurrency()`. Holds a single shared
 * {@link Semaphore} when unkeyed, or an LRU of per-key semaphores when a
 * `key` selector is configured. One instance per Route (see
 * {@link ConcurrencyController}), never one per exchange.
 *
 * @internal
 */
export class ConcurrencyLimiter {
  readonly #options: ResolvedConcurrencyOptions;
  #single?: Semaphore;
  readonly #keyed?: LRUCache<string, Semaphore>;

  constructor(options: ResolvedConcurrencyOptions) {
    this.#options = options;
    if (options.key) {
      // Per-key semaphores live in an LRU so memory stays bounded under an
      // unbounded key space. We do NOT try to protect an in-use pool from
      // eviction: re-admitting it inside lru-cache's `dispose` is unsafe
      // (a re-entrant `set` during eviction is swallowed and corrupts the
      // cache, per lru-cache's own docs). If a key with in-flight work is
      // evicted (only possible when more than `maxKeys` distinct keys are
      // live at once), its existing holders keep their slots via the
      // release closures and drain correctly; the next call for that key
      // builds a fresh pool. The transient effect is a bounded over-admit
      // for that one key at the eviction boundary (at most `max` extra
      // in-flight until the orphaned pool drains), the same self-correcting
      // trade-off `.throttle()` accepts for its keyed buckets. Raise
      // `maxKeys` if a hard per-key cap must hold under extreme cardinality.
      this.#keyed = new LRUCache<string, Semaphore>({ max: options.maxKeys });
    }
  }

  /**
   * Resolve the {@link Semaphore} for `exchange` (the shared one, or the
   * per-key one, creating it on first use), plus the partition key it
   * belongs to (absent when unkeyed).
   */
  semaphoreFor(exchange: Exchange): { semaphore: Semaphore; key?: string } {
    if (!this.#options.key) {
      this.#single ??= new Semaphore(this.#options.max);
      return { semaphore: this.#single };
    }
    let key: string;
    try {
      key = this.#options.key(exchange);
    } catch (err) {
      throw rcError("RC5003", err, {
        message:
          'concurrency({ key }) selector threw; it must return a string for every exchange (e.g. coalesce a missing value with `?? "anonymous"`).',
      });
    }
    let semaphore = this.#keyed!.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(this.#options.max);
      this.#keyed!.set(key, semaphore);
    }
    return { semaphore, key };
  }
}

/**
 * Lifecycle hooks the bulkhead reports to, so the step-scope wrapper and
 * the route-scope segment emit the same `route:concurrency:*` events with
 * their own `scope` / `stepLabel` bindings.
 *
 * @internal
 */
export interface ConcurrencyHooks {
  /** Route abort signal; cancels the queue wait on shutdown. */
  signal?: AbortSignal;
  /** All slots were busy; the exchange joins the wait queue at `queueDepth`. */
  onQueued(queueDepth: number, key?: string): void;
  /**
   * A slot was acquired. `waited` is true when the exchange had to queue
   * first; `inUse` is the slot count after admission.
   */
  onAcquired(waited: boolean, inUse: number, key?: string): void;
  /** The held slot was released; `heldMs` is how long the work held it. */
  onReleased(heldMs: number, key?: string): void;
  /**
   * The exchange was failed fast (`RC5026`): `reason` is `"busy"` (reject
   * mode, all slots busy) or `"queue-full"` (queue mode, wait line at
   * `maxQueue`).
   */
  onRejected(reason: "busy" | "queue-full", key?: string): void;
}

/** Event-scope bindings shared by the `route:concurrency:*` payloads. */
export interface ConcurrencyEventScope {
  routeId: string;
  exchangeId: string;
  correlationId: string;
  stepLabel: string;
  scope: "route" | "step";
  /** Optional limiter label, when configured. */
  label?: string;
}

/**
 * Build the {@link ConcurrencyHooks} that emit the `route:concurrency:*`
 * events. Shared by the step-scope wrapper and the route-scope segment so
 * the payload shape lives in one place (only the `scoped` descriptor and
 * the `emit` guard differ). `context?.emit` no-ops when the exchange
 * carries no context.
 *
 * @internal
 */
export function concurrencyEmitHooks(
  context: CraftContext | undefined,
  scoped: ConcurrencyEventScope,
  emit: boolean,
): Pick<
  ConcurrencyHooks,
  "onQueued" | "onAcquired" | "onReleased" | "onRejected"
> {
  return {
    onQueued: (queueDepth, key) => {
      if (emit) {
        context?.emit("route:concurrency:queued", {
          ...scoped,
          queueDepth,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
    onAcquired: (waited, inUse, key) => {
      if (emit) {
        context?.emit("route:concurrency:acquired", {
          ...scoped,
          waited,
          inUse,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
    onReleased: (heldMs, key) => {
      if (emit) {
        context?.emit("route:concurrency:released", {
          ...scoped,
          heldMs,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
    onRejected: (reason, key) => {
      if (emit) {
        context?.emit("route:concurrency:rejected", {
          ...scoped,
          reason,
          ...(key !== undefined ? { key } : {}),
        });
      }
    },
  };
}

/**
 * Owns the bulkhead state for one `.concurrency()` across every Route the
 * enclosing step (or segment) runs in. Keyed by Route in a WeakMap, so a
 * single definition registered into multiple contexts gives each Route its
 * OWN slot pool rather than one shared bulkhead (which would let the
 * contexts steal each other's slots). Mirrors {@link ThrottleController}.
 *
 * @internal
 */
export class ConcurrencyController extends RouteScopedController<ConcurrencyLimiter> {
  readonly #options: ResolvedConcurrencyOptions;

  constructor(options: ResolvedConcurrencyOptions) {
    super();
    this.#options = options;
  }

  /** Optional limiter label, surfaced on the `route:concurrency:*` events. */
  get label(): string | undefined {
    return this.#options.label;
  }

  protected createState(): ConcurrencyLimiter {
    return new ConcurrencyLimiter(this.#options);
  }

  /**
   * Build the `RC5026` rejection message. A private method (not a per-call
   * closure or an eagerly-built string) so the hot admit path allocates
   * nothing: it runs only on the cold reject path. When keyed, `max` is the
   * PER-KEY limit, so the message says so rather than reading as a global cap.
   */
  #rejectionMessage(key: string | undefined, queueFull: boolean): string {
    const limit =
      key !== undefined
        ? `the per-key concurrency limit of ${this.#options.max} is full for key "${key}"`
        : `all ${this.#options.max} concurrency slots are busy`;
    const tail = queueFull
      ? ` and the wait queue is full (maxQueue ${this.#options.maxQueue})`
      : "";
    return `concurrency rejected the exchange: ${limit}${tail}.`;
  }

  /**
   * Acquire a slot for `exchange`. In `queue` mode (default) the caller
   * waits FIFO when the pool is full (bounded by `maxQueue`); the wait is
   * cancellable, so on route shutdown the exchange is admitted rather than
   * stranded. In `reject` mode a busy pool fails fast with `RC5026` without
   * waiting. Returns the (idempotent) release function plus the partition
   * key it was charged against (absent when unkeyed).
   */
  async acquire(
    exchange: Exchange,
    route: Route | undefined,
    hooks: ConcurrencyHooks,
  ): Promise<{ release: () => void; key?: string }> {
    const { semaphore, key } = this.stateFor(route).semaphoreFor(exchange);

    if (this.#options.mode === "reject") {
      const release = semaphore.tryAcquire();
      if (release) {
        hooks.onAcquired(false, semaphore.inUse, key);
        return { release, ...(key !== undefined ? { key } : {}) };
      }
      hooks.onRejected("busy", key);
      throw rcError("RC5026", undefined, {
        message: this.#rejectionMessage(key, false),
      });
    }

    // Queue mode: take a free slot immediately, else join the bounded wait
    // line. `waiting >= maxQueue` is checked BEFORE queueing so the cap
    // counts only exchanges actually parked (not the one being admitted).
    const free = semaphore.tryAcquire();
    if (free) {
      hooks.onAcquired(false, semaphore.inUse, key);
      return { release: free, ...(key !== undefined ? { key } : {}) };
    }
    if (semaphore.waiting >= this.#options.maxQueue) {
      hooks.onRejected("queue-full", key);
      throw rcError("RC5026", undefined, {
        message: this.#rejectionMessage(key, true),
      });
    }

    hooks.onQueued(semaphore.waiting + 1, key);
    try {
      const release = await semaphore.acquire(hooks.signal);
      hooks.onAcquired(true, semaphore.inUse, key);
      return { release, ...(key !== undefined ? { key } : {}) };
    } catch (err) {
      if (!(err instanceof SleepAbortedError)) throw err;
      // Route shutdown while queued: admit the exchange (with a no-op
      // release) so teardown processes it rather than dropping it. No slot
      // is charged (`inUse` excludes this exchange), but we still emit the
      // balanced `acquired` -> `released` pair so the `queued` event already
      // fired above has a matching terminal; suppressing them would leave an
      // orphaned `queued` and unbalance queue-depth accounting at teardown.
      hooks.onAcquired(true, semaphore.inUse, key);
      return { release: () => {}, ...(key !== undefined ? { key } : {}) };
    }
  }
}

/**
 * Run `run` under the bulkhead `controller` for `route`: acquire a slot
 * (queueing or fast-failing per mode), run the work, and release the slot
 * in a `finally` so a throw, drop, or success all free it exactly once.
 * Shared by the step-scope wrapper and the route-scope segment so the
 * acquire / release protocol lives in one place, mirroring
 * `executeWithCircuitBreaker` / `executeWithRetry`.
 *
 * @internal
 */
export async function executeWithConcurrency(
  controller: ConcurrencyController,
  exchange: Exchange,
  route: Route | undefined,
  hooks: ConcurrencyHooks,
  run: () => Promise<StepOutcome>,
): Promise<StepOutcome> {
  const { release, key } = await controller.acquire(exchange, route, hooks);
  const heldStart = Date.now();
  try {
    return await run();
  } finally {
    release();
    hooks.onReleased(Date.now() - heldStart, key);
  }
}

/**
 * Step-scope `.concurrency()` wrapper. Bounds the wrapped step to `max`
 * simultaneous in-flight exchanges, queueing (backpressure) or fast-failing
 * (`RC5026`) the rest per `mode`.
 *
 * The slot pool lives on a {@link ConcurrencyController} keyed by Route, so
 * every exchange on a given Route shares one bulkhead while distinct Routes
 * (even from the same definition) stay isolated. This is the deliberate
 * per-ROUTE shared-state exception to the `WrapperStep` rule (see
 * `.standards/resilience-wrappers.md` section 8).
 *
 * Emits the `route:concurrency:queued` / `:acquired` / `:released` /
 * `:rejected` family with `scope: "step"`.
 */
export class ConcurrencyWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #controller: ConcurrencyController;

  constructor(inner: Step<T>, options: ConcurrencyOptions) {
    super(inner);
    this.#controller = new ConcurrencyController(
      resolveConcurrencyOptions(options),
    );
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { route, context, routeId, stepLabel, correlationId } =
      wrapperEventScope(exchange, this);
    const shouldEmit = Boolean(route && context && routeId);
    const scoped: ConcurrencyEventScope = {
      routeId: routeId as string,
      exchangeId: exchange.id,
      correlationId,
      stepLabel,
      scope: "step",
      ...(this.#controller.label !== undefined
        ? { label: this.#controller.label }
        : {}),
    };

    return executeWithConcurrency(
      this.#controller,
      exchange,
      route,
      {
        ...(route ? { signal: route.signal } : {}),
        ...concurrencyEmitHooks(context, scoped, shouldEmit),
      },
      () => this.inner.execute(exchange, ctx),
    );
  }
}
