import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  cloneExchange,
  getExchangeRoute,
  markDropped,
  emitExchangeDropped,
} from "../exchange.ts";
import { wrapperEventScope } from "./event-scope.ts";
import { rcError } from "../error.ts";
import { RouteScopedController } from "./route-scoped-controller.ts";

/**
 * Options for the `.debounce()` flow-control operation.
 */
export interface DebounceOptions<In = unknown> {
  /**
   * Quiet window in milliseconds. An exchange is released only after
   * `waitMs` has elapsed with no newer arrival in its group; each new arrival
   * resets the window and supersedes (drops) the one being held. Must be a
   * finite number > 0.
   */
  waitMs: number;
  /**
   * Partition selector: exchanges sharing a key are debounced independently
   * (for example one quiet window per file path). When omitted, the whole
   * route shares a single window.
   */
  key?: (exchange: Exchange<In>) => string;
  /**
   * Upper bound in milliseconds on how long an exchange may be held from the
   * START of its burst, guaranteeing eventual release under continuous
   * activity (otherwise a steady stream of arrivals could reset `waitMs`
   * forever and starve the trailing edge). Measured from the first arrival in
   * the burst and NOT reset by later arrivals. Must be a finite number
   * `>= waitMs` when set.
   */
  maxWaitMs?: number;
}

/**
 * {@link DebounceOptions} with every field resolved and validated.
 *
 * @internal
 */
export interface ResolvedDebounceOptions {
  waitMs: number;
  key: ((exchange: Exchange) => string) | undefined;
  maxWaitMs: number | undefined;
}

/**
 * Validate user-supplied {@link DebounceOptions} into a
 * {@link ResolvedDebounceOptions}. Rejects at build time (RC5003) so a
 * mis-specified window fails when the route is built rather than at runtime.
 *
 * @internal
 */
export function resolveDebounceOptions(
  options: DebounceOptions<unknown>,
): ResolvedDebounceOptions {
  if (typeof options !== "object" || options === null) {
    throw rcError("RC5003", undefined, {
      message: "debounce() requires an options object with a `waitMs`.",
    });
  }
  const { waitMs, maxWaitMs, key } = options;
  // Defend JS callers and widened values: a non-function `key` would pass
  // the build and then throw a raw TypeError on every exchange. Mirrors the
  // sticky-key validation in dispatch.
  if (key !== undefined && typeof key !== "function") {
    throw rcError("RC5003", undefined, {
      message: `debounce({ key }) must be a function deriving the partition key, got ${typeof key}.`,
    });
  }
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw rcError("RC5003", undefined, {
      message: `debounce({ waitMs }) must be a finite number > 0 (milliseconds), got ${String(waitMs)}.`,
    });
  }
  if (maxWaitMs !== undefined) {
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
      throw rcError("RC5003", undefined, {
        message: `debounce({ maxWaitMs }) must be a finite number > 0 (milliseconds), got ${String(maxWaitMs)}.`,
      });
    }
    if (maxWaitMs < waitMs) {
      throw rcError("RC5003", undefined, {
        message: `debounce({ maxWaitMs }) must be >= waitMs (${waitMs}), got ${maxWaitMs}.`,
      });
    }
  }
  return {
    waitMs,
    key: key as ((exchange: Exchange) => string) | undefined,
    maxWaitMs,
  };
}

/**
 * Why a held exchange was released. `"quiet"`: the `waitMs` window closed;
 * `"maxWait"`: the `maxWaitMs` cap fired during continuous activity;
 * `"flush"`: a drain / shutdown released it early.
 *
 * @internal
 */
type ReleaseReason = "quiet" | "maxWait" | "flush";

/**
 * One held burst for a single key: the exchange currently being held, its
 * pacing timers, and the deferred that keeps the route's `drain()` waiting
 * until the burst releases.
 *
 * @internal
 */
interface PendingHold {
  /** The most recent arrival in the burst (the one that will be released). */
  exchange: Exchange;
  /** Fires `waitMs` after the latest arrival; reset on each new arrival. */
  waitTimer: ReturnType<typeof setTimeout>;
  /** Fires `maxWaitMs` after the FIRST arrival; never reset. */
  maxTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves the tracked in-flight promise once the burst releases. */
  settle: () => void;
}

/**
 * Per-route debounce state: the captured downstream runner (shared across the
 * route's exchanges) and the per-key holds. One instance per Route (see
 * {@link DebounceController}), never one per exchange.
 *
 * @internal
 */
class DebounceState {
  /** Runs a released exchange through the steps after debounce; captured once. */
  runner: ((exchange: Exchange) => Promise<{ failed: boolean }>) | undefined;
  /** Active holds keyed by partition key (`""` when no `key` selector). */
  readonly pending = new Map<string, PendingHold>();
  /** Whether the drain / abort flush hooks have been wired for this route. */
  flushRegistered = false;
}

/**
 * Owns the debounce state for one `.debounce()` across every Route the step
 * runs in (see {@link RouteScopedController}).
 *
 * @internal
 */
class DebounceController extends RouteScopedController<DebounceState> {
  protected createState(): DebounceState {
    return new DebounceState();
  }
}

/** Marker adapter for the debounce step; carries no configuration. */
export interface DebounceAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.debounce";
}

/**
 * Step that suppresses bursts of exchanges, releasing only the LAST one in a
 * burst after a quiet period. The archetypal use is collapsing a flurry of
 * file-change or search-as-you-type events down to their final state.
 *
 * Each arrival is held (not passed downstream) and resets a `waitMs` quiet
 * timer; a newer arrival in the same group supersedes and drops the one being
 * held. When the timer finally fires (or the optional `maxWaitMs` cap elapses
 * from the burst's start, guaranteeing progress under continuous activity),
 * the held exchange is released through the steps that follow `.debounce()`.
 * An optional `key` selector debounces independently per group.
 *
 * This is the only operation that breaks the "process each exchange
 * immediately" model: it holds an exchange OUTSIDE the pipeline queue and
 * re-runs it later via the executor's captured downstream continuation, so a
 * released exchange runs the post-debounce steps as a fresh exchange (new id,
 * preserved correlation id) with its own `exchange:started` / `:completed`
 * lifecycle. Because the hold lives outside the queue, a pending exchange is
 * flushed on `drain()` / shutdown rather than being lost.
 *
 * Emits `route:operation:debounce:held` (arrival held / timer reset),
 * `route:operation:debounce:dropped` (a held exchange superseded), and
 * `route:operation:debounce:released` (the trailing exchange released).
 */
export class DebounceStep<In = unknown> implements Step<DebounceAdapter> {
  operation: OperationType = OperationType.DEBOUNCE;
  label?: string;
  adapter: DebounceAdapter = { adapterId: "routecraft.operation.debounce" };
  skipStepEvents = true;

  readonly #options: ResolvedDebounceOptions;
  readonly #controller = new DebounceController();

  constructor(options: DebounceOptions<In>) {
    this.#options = resolveDebounceOptions(options as DebounceOptions<unknown>);
  }

  async execute(
    exchange: Exchange<In>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { route, context, routeId, correlationId, stepLabel } =
      wrapperEventScope(exchange, this);
    const stepStart = Date.now();

    // Without a context there is nowhere to emit or run downstream; pass the
    // exchange through unchanged (defensive, mirrors the other operations).
    if (!context) {
      return { kind: "continue", exchange };
    }

    context.emit("route:step:started", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: stepLabel,
    });

    const state = this.#controller.stateFor(route);
    // Capture the downstream continuation once: debounce sits at a fixed
    // pipeline position, so the steps after it are the same for every arrival.
    state.runner ??= ctx.captureDownstream();
    this.#ensureFlushHooks(state, route);

    const key = this.#options.key ? this.#options.key(exchange) : "";
    const keyField = this.#options.key ? { key } : {};

    // The arrival is absorbed into the hold, so mark it dropped now to
    // suppress its own `exchange:completed`; the released exchange (built at
    // release time) carries the downstream lifecycle instead.
    markDropped(exchange);

    const existing = state.pending.get(key);
    if (existing) {
      // Supersede: the exchange currently held loses to this newer arrival.
      const superseded = existing.exchange;
      context.emit("route:operation:debounce:dropped", {
        routeId,
        exchangeId: superseded.id,
        correlationId: superseded.headers[HeadersKeys.CORRELATION_ID] as string,
        ...keyField,
      });
      emitExchangeDropped(context, {
        routeId,
        correlationId: superseded.headers[HeadersKeys.CORRELATION_ID] as string,
        reason: "debounced",
        exchange: superseded,
      });
      clearTimeout(existing.waitTimer);
      existing.exchange = exchange;
      existing.waitTimer = setTimeout(
        () => this.#release(state, key, "quiet"),
        this.#options.waitMs,
      );
      // maxTimer is deliberately NOT reset: it caps the whole burst.
    } else {
      // Burst start: create the hold and a tracked promise so drain() waits
      // for the eventual release instead of finishing while it is pending.
      let settle: () => void = () => {};
      const tracked = new Promise<void>((resolve) => {
        settle = resolve;
      });
      route?.trackTask(tracked);
      const hold: PendingHold = {
        exchange,
        waitTimer: setTimeout(
          () => this.#release(state, key, "quiet"),
          this.#options.waitMs,
        ),
        maxTimer:
          this.#options.maxWaitMs !== undefined
            ? setTimeout(
                () => this.#release(state, key, "maxWait"),
                this.#options.maxWaitMs,
              )
            : undefined,
        settle,
      };
      state.pending.set(key, hold);
    }

    context.emit("route:operation:debounce:held", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      ...keyField,
    });

    context.emit("route:step:completed", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: stepLabel,
      duration: Date.now() - stepStart,
    });

    // An arrival delivered after the route's signal aborted would never be
    // abort-flushed (the abort listener fired, or was never installed
    // because the signal was already aborted when the hooks were wired):
    // flush its hold immediately so shutdown does not wait out the timer.
    if (route?.signal.aborted) {
      this.#release(state, key, "flush");
    }

    // The arrival never continues in-line; it is released later (or dropped
    // when superseded).
    return { kind: "drop" };
  }

  /**
   * Wire the drain and abort flush hooks for this route exactly once, so a
   * held exchange is released promptly on `drain()` / shutdown instead of
   * waiting out its timer (or being lost when the route stops).
   */
  #ensureFlushHooks(
    state: DebounceState,
    route: ReturnType<typeof getExchangeRoute>,
  ): void {
    if (state.flushRegistered || !route) return;
    state.flushRegistered = true;
    route.onDrain(() => this.#flushAll(state));
    // No listener when the signal is already aborted: it would never fire,
    // and flushing here would hit an empty map (the hold is created after
    // this call). Post-abort arrivals are flushed per-arrival in execute()
    // instead, which covers both this first arrival and later ones.
    if (!route.signal.aborted) {
      route.signal.addEventListener("abort", () => this.#flushAll(state), {
        once: true,
      });
    }
  }

  /** Release every pending hold immediately (drain / shutdown). Idempotent. */
  #flushAll(state: DebounceState): void {
    for (const key of [...state.pending.keys()]) {
      this.#release(state, key, "flush");
    }
  }

  /**
   * Release the held exchange for `key` through the downstream continuation.
   *
   * Infallible by design: this runs from bare timer callbacks, the route's
   * abort listener, and drain flush callbacks, none of which sit inside the
   * executor's per-step try/catch. A synchronous throw here (most likely
   * `cloneExchange` on a non-structured-cloneable body) would otherwise
   * crash the process or shutdown, and, because the hold is already removed
   * from `pending`, leave the tracked promise unsettled and hang `drain()`
   * forever. Every path, success or failure, settles the hold.
   */
  #release(state: DebounceState, key: string, reason: ReleaseReason): void {
    const hold = state.pending.get(key);
    if (!hold) return;
    state.pending.delete(key);
    clearTimeout(hold.waitTimer);
    if (hold.maxTimer) clearTimeout(hold.maxTimer);

    const held = hold.exchange;
    const { route, context, routeId, correlationId } = wrapperEventScope(
      held,
      this,
    );

    // Clone FIRST, before any terminal event for the held arrival, so a
    // clone failure produces a single coherent terminal (`exchange:failed`)
    // instead of a drop followed by a crash. cloneExchange gives fresh
    // internals (a new id, preserved correlation id) and binds the route so
    // the released exchange is executor-ready; the held one was marked
    // dropped at hold time and cannot carry the release itself.
    let released: Exchange;
    try {
      released = context ? cloneExchange(held, context, route) : held;
    } catch (err) {
      held.logger.error(
        { err, reason },
        "debounce release failed: the held body is not structured-cloneable",
      );
      context?.emit("route:exchange:failed", {
        routeId,
        exchangeId: held.id,
        correlationId,
        duration: 0,
        error: err,
        exchange: held,
      });
      hold.settle();
      return;
    }

    // Balance the absorbed arrival's lifecycle: it emitted `exchange:started`
    // on entry and was only MARKED dropped at hold time, so without this
    // emission its id would have a `started` with no terminal event, reading
    // as permanently in-flight to observers that pair them, and leaking any
    // upstream reservation keyed to the arrival id (e.g. a `.dedupe()`
    // before the debounce commits/releases on terminal events). Emitted at
    // release time, not hold time, so a superseded arrival's drop stays
    // attributable to its superseder in the supersede branch above.
    emitExchangeDropped(context, {
      routeId,
      correlationId,
      reason: "debounced",
      exchange: held,
    });

    context?.emit("route:operation:debounce:released", {
      routeId,
      exchangeId: released.id,
      correlationId,
      ...(this.#options.key ? { key } : {}),
      reason,
    });

    const runner = state.runner;
    const run = runner ? runner(released) : Promise.resolve();
    // Settle the tracked promise once the downstream run finishes, so drain()
    // waits for the released exchange to complete, not merely to be
    // scheduled. The runner is engineered never to reject (runPipeline
    // without rethrowUnhandled contains step errors), but that invariant
    // lives across a module boundary: catch defensively so a future change
    // cannot turn a release into a fatal unhandledRejection.
    void Promise.resolve(run)
      .catch((err: unknown) => {
        held.logger.error({ err }, "debounce release runner rejected");
      })
      .finally(() => hold.settle());
  }
}

/**
 * Build the {@link DebounceStep} for a `.debounce(options)` call. Keeps the
 * step value encapsulated in this module so the builder only depends on the
 * helper.
 *
 * @internal
 */
export function buildDebounceStep<In = unknown>(
  options: DebounceOptions<In>,
): DebounceStep<In> {
  return new DebounceStep<In>(options);
}
