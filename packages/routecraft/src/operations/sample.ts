import { type Adapter, type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  emitExchangeDropped,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Route } from "../route.ts";

/**
 * Options for the `.sample()` flow-control operation. Exactly one of
 * `every` or `intervalMs` must be set; they are mutually exclusive (a
 * sampler is either count-based or time-based, not both).
 */
export interface SampleOptions {
  /**
   * Count-based: pass every Nth exchange and drop the rest. The internal
   * counter increments per exchange and the exchange passes when
   * `counter % every === 0`, so `{ every: 5 }` passes the 5th, 10th, 15th,
   * ... exchange. Must be a finite integer >= 1.
   */
  every?: number;
  /**
   * Time-based: pass the first exchange seen in each window of `intervalMs`
   * milliseconds and drop the rest until the window elapses. Must be a
   * finite number > 0.
   */
  intervalMs?: number;
}

/**
 * {@link SampleOptions} with the sampling mode resolved and validated.
 *
 * @internal
 */
export interface ResolvedSampleOptions {
  mode: "count" | "interval";
  every?: number;
  intervalMs?: number;
}

/**
 * Validate user-supplied {@link SampleOptions} into a
 * {@link ResolvedSampleOptions}. Rejects at build time (RC5003) so a
 * mis-specified sampler fails when the route is built rather than silently
 * passing or dropping every exchange at runtime.
 *
 * @internal
 */
export function resolveSampleOptions(
  options: SampleOptions,
): ResolvedSampleOptions {
  const hasEvery = options.every !== undefined;
  const hasInterval = options.intervalMs !== undefined;

  if (hasEvery === hasInterval) {
    throw rcError("RC5003", undefined, {
      message:
        "sample() requires exactly one of `every` or `intervalMs` (they are mutually exclusive).",
    });
  }

  if (hasEvery) {
    const every = options.every!;
    if (!Number.isInteger(every) || every < 1) {
      throw rcError("RC5003", undefined, {
        message: `sample({ every }) must be an integer >= 1, got ${String(every)}.`,
      });
    }
    return { mode: "count", every };
  }

  const intervalMs = options.intervalMs!;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw rcError("RC5003", undefined, {
      message: `sample({ intervalMs }) must be a finite number > 0, got ${String(intervalMs)}.`,
    });
  }
  return { mode: "interval", intervalMs };
}

/**
 * Per-route sampler state. Count mode keeps a running counter; interval
 * mode keeps the timestamp of the last admitted exchange. One instance per
 * Route (see {@link SampleController}), never one per exchange.
 *
 * @internal
 */
class SampleState {
  count = 0;
  lastPassedAt: number | undefined;
}

/**
 * Owns the sampler state for one `.sample()` across every Route the step
 * runs in. Keyed by Route in a WeakMap, so a single step instance shared by
 * a `RouteDefinition` registered into multiple contexts gives each Route its
 * OWN counter / window rather than one shared sampler (which would let the
 * contexts cross-sample each other). Mirrors `ThrottleController`.
 *
 * @internal
 */
class SampleController {
  readonly #byRoute = new WeakMap<Route, SampleState>();
  #routeless?: SampleState;

  stateFor(route: Route | undefined): SampleState {
    if (!route) {
      this.#routeless ??= new SampleState();
      return this.#routeless;
    }
    let state = this.#byRoute.get(route);
    if (!state) {
      state = new SampleState();
      this.#byRoute.set(route, state);
    }
    return state;
  }
}

/** Marker adapter for the sample step; carries no configuration. */
export interface SampleAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.sample";
}

/**
 * Step that samples exchanges by count (`every`) or time window
 * (`intervalMs`), passing the admitted ones and dropping the rest. A drop
 * is silent (no error), exactly like a `filter` predicate returning false:
 * it emits `route:operation:sample:dropped` and `route:exchange:dropped`
 * (reason `"sampled"`) so telemetry and the TUI can count it.
 *
 * Sampler state is per-route (see {@link SampleController}), so every
 * exchange on a given Route shares one counter / window while distinct
 * Routes stay isolated.
 */
export class SampleStep implements Step<SampleAdapter> {
  operation: OperationType = OperationType.SAMPLE;
  label?: string;
  adapter: SampleAdapter = { adapterId: "routecraft.operation.sample" };
  skipStepEvents = true;

  readonly #options: ResolvedSampleOptions;
  readonly #controller = new SampleController();

  constructor(options: SampleOptions) {
    this.#options = resolveSampleOptions(options);
  }

  async execute(exchange: Exchange): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const stepLabel = this.label ?? this.operation;
    const stepStart = Date.now();
    const { mode } = this.#options;

    if (context) {
      context.emit("route:step:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
      });
    }

    const state = this.#controller.stateFor(route);
    const pass = this.#shouldPass(state);

    if (context) {
      context.emit("route:step:completed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        duration: Date.now() - stepStart,
      });
    }

    if (!pass) {
      context?.emit("route:operation:sample:dropped", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        mode,
      });
      emitExchangeDropped(context, {
        routeId,
        correlationId,
        reason: "sampled",
        exchange,
      });
      return { kind: "drop" };
    }

    context?.emit("route:operation:sample:passed", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      mode,
    });
    return { kind: "continue", exchange };
  }

  /** Advance the sampler state and decide whether this exchange passes. */
  #shouldPass(state: SampleState): boolean {
    if (this.#options.mode === "count") {
      state.count += 1;
      return state.count % this.#options.every! === 0;
    }
    const now = Date.now();
    if (
      state.lastPassedAt === undefined ||
      now - state.lastPassedAt >= this.#options.intervalMs!
    ) {
      state.lastPassedAt = now;
      return true;
    }
    return false;
  }
}
