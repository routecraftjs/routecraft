import { type Exchange, DefaultExchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import type { CraftContext } from "../context.ts";
import type { Route } from "../route.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { assertDurationMs } from "./cancellable-sleep.ts";
import { defaultRetryOn } from "./retry-wrapper.ts";

/**
 * The three states of a circuit breaker.
 *
 * - `closed`: calls flow through; failures within the sliding window are
 *   counted, and the breaker trips to `open` once they reach the
 *   threshold.
 * - `open`: calls fast-fail (fallback or `RC5025`) without running the
 *   protected work, until `cooldownMs` has elapsed.
 * - `half-open`: a bounded number of probe calls are allowed through to
 *   test whether the downstream has recovered; one success closes the
 *   breaker, one failure re-opens it.
 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/**
 * Options for the `.circuitBreaker()` operation (step scope and route
 * scope). A breaker tracks failures over a sliding window and short-circuits
 * execution when the target is known to be failing, so a flaky downstream
 * does not turn into a pile of slow, doomed calls.
 */
export interface CircuitBreakerOptions {
  /**
   * Number of failures within `windowMs` that trips the breaker from
   * `closed` to `open`. Must be a finite integer >= 1.
   */
  failureThreshold: number;
  /**
   * Sliding window (ms) over which failures are counted. Failures older
   * than this no longer count toward the threshold. Default `60_000`.
   */
  windowMs?: number;
  /**
   * How long (ms) the breaker stays `open` before allowing a probe
   * (transition to `half-open`). Default `30_000`.
   */
  cooldownMs?: number;
  /**
   * Maximum concurrent probe calls allowed in the `half-open` state.
   * Default `1`. Values above 1 are best-effort: the first probe to
   * succeed closes the breaker, so concurrent probes resolving after it
   * are accounted against the now-closed breaker.
   */
  halfOpenMax?: number;
  /**
   * Value to return when the breaker rejects a call (open, or half-open
   * at capacity). When set, the rejected exchange's body becomes
   * `fallback(exchange)` and the pipeline continues; when omitted, the
   * breaker throws `RC5025` so a `.error()` handler (or the default
   * error path) can react.
   */
  fallback?: (exchange: Exchange) => unknown;
  /**
   * Callback fired on every state transition (`opened` / `halfOpen` /
   * `closed`). Side-effect hook for logging or metrics; it must not
   * throw.
   */
  onStateChange?: (state: CircuitBreakerState) => void;
  /**
   * Decide whether a failed call counts toward the failure threshold.
   * Default: count everything except `RoutecraftError`s flagged
   * `retryable: false` (auth `RC5012`, validation `RC5002`, etc.), which
   * are deterministic and not evidence the downstream is unhealthy. This
   * mirrors `.retry()`'s `retryOn` default.
   */
  isFailure?: (error: Error) => boolean;
  /**
   * Optional label carried on this breaker's `route:circuitBreaker:*`
   * events, so stacked or sibling breakers can be told apart in logs and
   * metrics. Has no effect on behaviour.
   */
  label?: string;
}

/**
 * {@link CircuitBreakerOptions} with every behavioural field populated.
 * This is the shape stored behind {@link CircuitBreakerController} and is
 * shared by the step-scope wrapper and the route-scope segment.
 *
 * @internal
 */
export interface ResolvedCircuitBreakerOptions {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  halfOpenMax: number;
  fallback?: (exchange: Exchange) => unknown;
  onStateChange?: (state: CircuitBreakerState) => void;
  isFailure: (error: Error) => boolean;
  label?: string;
}

/**
 * Validate user-supplied {@link CircuitBreakerOptions} into a
 * {@link ResolvedCircuitBreakerOptions}. Rejects at build time (RC5003)
 * so a typo fails when the route is built rather than at first dispatch.
 *
 * @internal
 */
export function resolveCircuitBreakerOptions(
  options: CircuitBreakerOptions,
): ResolvedCircuitBreakerOptions {
  const {
    failureThreshold,
    windowMs = 60_000,
    cooldownMs = 30_000,
    halfOpenMax = 1,
    fallback,
    onStateChange,
    isFailure = defaultRetryOn,
    label,
  } = options;

  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw rcError("RC5003", undefined, {
      message: `circuitBreaker({ failureThreshold }) must be an integer >= 1, got ${String(failureThreshold)}.`,
    });
  }
  assertDurationMs("circuitBreaker({ windowMs })", windowMs, 1);
  assertDurationMs("circuitBreaker({ cooldownMs })", cooldownMs, 1);
  if (!Number.isInteger(halfOpenMax) || halfOpenMax < 1) {
    throw rcError("RC5003", undefined, {
      message: `circuitBreaker({ halfOpenMax }) must be an integer >= 1, got ${String(halfOpenMax)}.`,
    });
  }

  return {
    failureThreshold,
    windowMs,
    cooldownMs,
    halfOpenMax,
    isFailure,
    ...(fallback ? { fallback } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Decision returned by {@link CircuitBreakerMachine.acquire}. `probe` is
 * true when the admitted call is a half-open probe, so the matching
 * record call knows to release the probe slot and apply half-open
 * transition semantics.
 *
 * @internal
 */
export type CircuitBreakerDecision =
  | { admitted: true; probe: boolean }
  | { admitted: false; state: "open" | "half-open"; retryAfterMs: number };

/**
 * Lifecycle hooks the breaker reports transitions to, so the step-scope
 * wrapper and the route-scope segment emit the same
 * `route:circuitBreaker:*` events with their own `scope` / `stepLabel`
 * bindings.
 *
 * @internal
 */
export interface CircuitBreakerHooks {
  /** Closed/half-open -> open (the breaker tripped). */
  onOpened(failureCount: number): void;
  /** Open -> half-open (cooldown elapsed; a probe is being admitted). */
  onHalfOpen(): void;
  /** Half-open -> closed (a probe succeeded; the breaker recovered). */
  onClosed(): void;
  /** A call was rejected because the breaker is open or half-open at capacity. */
  onRejected(state: "open" | "half-open", retryAfterMs: number): void;
}

/**
 * The per-route state machine. Holds the sliding window of failure
 * timestamps (a ring buffer, pruned on access, not a flat counter so the
 * window genuinely slides), the current state, the open timestamp, and
 * the in-flight half-open probe count. One instance per Route (see
 * {@link CircuitBreakerController}), never one per exchange.
 *
 * @internal
 */
export class CircuitBreakerMachine {
  #state: CircuitBreakerState = "closed";
  /** Timestamps of counted failures within the window, oldest first. */
  readonly #failures: number[] = [];
  #openedAt = 0;
  #halfOpenInFlight = 0;
  readonly #options: ResolvedCircuitBreakerOptions;

  constructor(options: ResolvedCircuitBreakerOptions) {
    this.#options = options;
  }

  /** Current breaker state (exposed for diagnostics and tests). */
  get state(): CircuitBreakerState {
    return this.#state;
  }

  #toState(to: CircuitBreakerState): void {
    this.#state = to;
    this.#options.onStateChange?.(to);
  }

  #prune(now: number): void {
    const cutoff = now - this.#options.windowMs;
    while (this.#failures.length > 0 && this.#failures[0]! < cutoff) {
      this.#failures.shift();
    }
  }

  /**
   * Decide whether the calling exchange may proceed. May transition
   * open -> half-open when the cooldown has elapsed. Emits `halfOpen` /
   * `rejected` via `hooks`.
   */
  acquire(now: number, hooks: CircuitBreakerHooks): CircuitBreakerDecision {
    if (this.#state === "open") {
      const elapsed = now - this.#openedAt;
      if (elapsed >= this.#options.cooldownMs) {
        this.#halfOpenInFlight = 0;
        this.#toState("half-open");
        hooks.onHalfOpen();
      } else {
        const retryAfterMs = this.#options.cooldownMs - elapsed;
        hooks.onRejected("open", retryAfterMs);
        return { admitted: false, state: "open", retryAfterMs };
      }
    }

    if (this.#state === "half-open") {
      if (this.#halfOpenInFlight < this.#options.halfOpenMax) {
        this.#halfOpenInFlight += 1;
        return { admitted: true, probe: true };
      }
      hooks.onRejected("half-open", 0);
      return { admitted: false, state: "half-open", retryAfterMs: 0 };
    }

    // closed
    return { admitted: true, probe: false };
  }

  /** Record a successful call. A successful probe closes the breaker. */
  recordSuccess(probe: boolean, hooks: CircuitBreakerHooks): void {
    if (probe && this.#halfOpenInFlight > 0) this.#halfOpenInFlight -= 1;
    if (this.#state === "half-open") {
      this.#failures.length = 0;
      this.#toState("closed");
      hooks.onClosed();
    }
    // In `closed`, a success does not retract windowed failures; the
    // window expiry does. In `open` a success cannot occur (no call ran).
  }

  /**
   * Record a failed call. `counts` is false for deterministic errors that
   * should not trip the breaker (the probe slot is still released so it
   * does not leak, but no state transition is applied).
   */
  recordFailure(
    now: number,
    probe: boolean,
    counts: boolean,
    hooks: CircuitBreakerHooks,
  ): void {
    if (probe && this.#halfOpenInFlight > 0) this.#halfOpenInFlight -= 1;
    if (!counts) return;

    if (this.#state === "half-open") {
      this.#openedAt = now;
      this.#toState("open");
      this.#prune(now);
      hooks.onOpened(this.#failures.length);
      return;
    }

    if (this.#state === "closed") {
      this.#failures.push(now);
      this.#prune(now);
      if (this.#failures.length >= this.#options.failureThreshold) {
        this.#openedAt = now;
        this.#toState("open");
        hooks.onOpened(this.#failures.length);
      }
    }
  }
}

/**
 * Owns the circuit-breaker state for one `.circuitBreaker()` across every
 * Route the enclosing step (or segment) runs in. Keyed by Route in a
 * WeakMap, so a single definition registered into multiple contexts gives
 * each Route its OWN breaker rather than one shared circuit (which would
 * let the contexts trip each other). Mirrors {@link ThrottleController}.
 *
 * @internal
 */
export class CircuitBreakerController {
  readonly #options: ResolvedCircuitBreakerOptions;
  readonly #byRoute = new WeakMap<Route, CircuitBreakerMachine>();
  #routeless?: CircuitBreakerMachine;

  constructor(options: ResolvedCircuitBreakerOptions) {
    this.#options = options;
  }

  /** The resolved options (fallback, threshold, cooldown, label, ...). */
  get options(): ResolvedCircuitBreakerOptions {
    return this.#options;
  }

  /** Optional gate label, surfaced on the `route:circuitBreaker:*` events. */
  get label(): string | undefined {
    return this.#options.label;
  }

  #machineFor(route: Route | undefined): CircuitBreakerMachine {
    if (!route) {
      this.#routeless ??= new CircuitBreakerMachine(this.#options);
      return this.#routeless;
    }
    let machine = this.#byRoute.get(route);
    if (!machine) {
      machine = new CircuitBreakerMachine(this.#options);
      this.#byRoute.set(route, machine);
    }
    return machine;
  }

  acquire(
    route: Route | undefined,
    hooks: CircuitBreakerHooks,
  ): CircuitBreakerDecision {
    return this.#machineFor(route).acquire(Date.now(), hooks);
  }

  recordSuccess(
    route: Route | undefined,
    probe: boolean,
    hooks: CircuitBreakerHooks,
  ): void {
    this.#machineFor(route).recordSuccess(probe, hooks);
  }

  recordFailure(
    route: Route | undefined,
    error: Error,
    probe: boolean,
    hooks: CircuitBreakerHooks,
  ): void {
    const counts = this.#options.isFailure(error);
    this.#machineFor(route).recordFailure(Date.now(), probe, counts, hooks);
  }
}

/** Event-scope bindings shared by the `route:circuitBreaker:*` payloads. */
export interface CircuitBreakerEventScope {
  routeId: string;
  exchangeId: string;
  correlationId: string;
  stepLabel: string;
  scope: "route" | "step";
  /** Optional breaker label, when configured. */
  label?: string;
}

/**
 * Build the {@link CircuitBreakerHooks} that emit the
 * `route:circuitBreaker:*` events. Shared by the step-scope wrapper and
 * the route-scope segment so the payload shape lives in one place (only
 * the `scoped` descriptor and the `emit` guard differ). `context?.emit`
 * no-ops when the exchange carries no context.
 *
 * @internal
 */
export function circuitBreakerEmitHooks(
  context: CraftContext | undefined,
  scoped: CircuitBreakerEventScope,
  emit: boolean,
  options: ResolvedCircuitBreakerOptions,
): CircuitBreakerHooks {
  return {
    onOpened: (failureCount) => {
      if (emit) {
        context?.emit("route:circuitBreaker:opened", {
          ...scoped,
          failureCount,
          threshold: options.failureThreshold,
          cooldownMs: options.cooldownMs,
        });
      }
    },
    onHalfOpen: () => {
      if (emit) context?.emit("route:circuitBreaker:halfOpen", { ...scoped });
    },
    onClosed: () => {
      if (emit) context?.emit("route:circuitBreaker:closed", { ...scoped });
    },
    onRejected: (state, retryAfterMs) => {
      if (emit) {
        context?.emit("route:circuitBreaker:rejected", {
          ...scoped,
          state,
          retryAfterMs,
        });
      }
    },
  };
}

/**
 * Outcome for a rejected call (breaker open, or half-open at capacity):
 * substitute the configured `fallback` body and continue, or throw
 * `RC5025` so the route's `.error()` handler (or the default error path)
 * decides what to do. Shared by the step-scope wrapper and the
 * route-scope segment.
 *
 * @internal
 */
export function circuitOpenOutcome(
  exchange: Exchange,
  options: ResolvedCircuitBreakerOptions,
  scopeDescription: string,
): StepOutcome {
  if (options.fallback) {
    return {
      kind: "continue",
      exchange: DefaultExchange.rewrap(exchange, {
        body: options.fallback(exchange),
      }),
    };
  }
  throw rcError("RC5025", undefined, {
    message: `Circuit breaker ${scopeDescription} is open; failing fast (no fallback configured).`,
  });
}

/**
 * Run `run` under the breaker `controller` for `route`, recording the
 * outcome: a resolve (success, or a drop) records a success, a throw
 * records a counted failure and re-throws. When the breaker rejects the
 * call (open, or half-open at capacity) the protected work is skipped and
 * `onOpen()` produces the substitute outcome (a `fallback` continue, or a
 * thrown `RC5025`).
 *
 * Shared by the step-scope wrapper and the route-scope segment so the
 * acquire / record protocol lives in one place, mirroring the retry
 * operation's `executeWithRetry`.
 *
 * @internal
 */
export async function executeWithCircuitBreaker(
  controller: CircuitBreakerController,
  route: Route | undefined,
  hooks: CircuitBreakerHooks,
  onOpen: () => StepOutcome,
  run: () => Promise<StepOutcome>,
): Promise<StepOutcome> {
  const decision = controller.acquire(route, hooks);
  if (!decision.admitted) return onOpen();
  try {
    const outcome = await run();
    controller.recordSuccess(route, decision.probe, hooks);
    return outcome;
  } catch (err) {
    controller.recordFailure(
      route,
      err instanceof Error ? err : new Error(String(err)),
      decision.probe,
      hooks,
    );
    throw err;
  }
}

/**
 * Step-scope `.circuitBreaker()` wrapper. Protects the immediately-next
 * step: counts its failures over a sliding window, trips after the
 * threshold, then fast-fails subsequent calls (fallback or `RC5025`)
 * until the cooldown elapses and a probe is allowed through. The breaker
 * state lives on a {@link CircuitBreakerController} keyed by Route, so
 * every exchange on a given Route shares one breaker while distinct
 * Routes (even from the same definition) stay isolated. This is the
 * deliberate per-ROUTE shared-state exception to the `WrapperStep` rule
 * (see `.standards/resilience-wrappers.md` section 8).
 *
 * Emits the `route:circuitBreaker:opened` / `:halfOpen` / `:closed` /
 * `:rejected` family with `scope: "step"`.
 */
export class CircuitBreakerWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #controller: CircuitBreakerController;

  constructor(inner: Step<T>, options: CircuitBreakerOptions) {
    super(inner);
    this.#controller = new CircuitBreakerController(
      resolveCircuitBreakerOptions(options),
    );
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { route, context, routeId, stepLabel, correlationId } =
      wrapperEventScope(exchange, this);
    const shouldEmit = Boolean(route && context && routeId);
    const scoped: CircuitBreakerEventScope = {
      routeId: routeId as string,
      exchangeId: exchange.id,
      correlationId,
      stepLabel,
      scope: "step",
      ...(this.#controller.label !== undefined
        ? { label: this.#controller.label }
        : {}),
    };
    const hooks = circuitBreakerEmitHooks(
      context,
      scoped,
      shouldEmit,
      this.#controller.options,
    );

    return executeWithCircuitBreaker(
      this.#controller,
      route,
      hooks,
      () =>
        circuitOpenOutcome(
          exchange,
          this.#controller.options,
          `for step "${stepLabel}"`,
        ),
      () => this.inner.execute(exchange, ctx),
    );
  }
}
