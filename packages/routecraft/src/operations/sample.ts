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
import { RouteScopedController } from "./route-scoped-controller.ts";

/**
 * Options for the `.sample()` flow-control operation. Exactly one of
 * `every` (count-based) or `intervalMs` (time-based) must be set; the union
 * makes them mutually exclusive at compile time (passing both, or neither,
 * is a type error), and {@link resolveSampleOptions} re-checks at runtime
 * for JS callers.
 */
export type SampleOptions =
  | {
      /**
       * Count-based: pass every Nth exchange and drop the rest, so
       * `{ every: 5 }` passes the 5th, 10th, 15th, ... exchange. Must be a
       * finite integer >= 1.
       */
      every: number;
      intervalMs?: never;
    }
  | {
      /**
       * Time-based: pass the first exchange seen in each window of
       * `intervalMs` milliseconds and drop the rest until the window
       * elapses. Must be a finite number > 0.
       */
      intervalMs: number;
      every?: never;
    };

/**
 * {@link SampleOptions} with the sampling mode resolved and validated. A
 * discriminated union, so narrowing on `mode` proves which numeric field is
 * present (no non-null assertions at the use site).
 *
 * @internal
 */
export type ResolvedSampleOptions =
  | { mode: "count"; every: number }
  | { mode: "interval"; intervalMs: number };

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
  const { every, intervalMs } = options;

  // The XOR is already a compile-time error for typed callers (the union's
  // `?: never` arms); these runtime checks defend JS callers and widened
  // values that bypass the types. One shared message so the two sites cannot
  // drift.
  const exclusiveMessage =
    "sample() requires exactly one of `every` or `intervalMs` (they are mutually exclusive).";

  if (every !== undefined && intervalMs !== undefined) {
    throw rcError("RC5003", undefined, { message: exclusiveMessage });
  }

  if (every !== undefined) {
    if (!Number.isInteger(every) || every < 1) {
      throw rcError("RC5003", undefined, {
        message: `sample({ every }) must be an integer >= 1, got ${String(every)}.`,
      });
    }
    return { mode: "count", every };
  }

  if (intervalMs !== undefined) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw rcError("RC5003", undefined, {
        message: `sample({ intervalMs }) must be a finite number > 0, got ${String(intervalMs)}.`,
      });
    }
    return { mode: "interval", intervalMs };
  }

  throw rcError("RC5003", undefined, { message: exclusiveMessage });
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
 * runs in (see {@link RouteScopedController}): each Route gets its own
 * counter / window so contexts cannot cross-sample each other.
 *
 * @internal
 */
class SampleController extends RouteScopedController<SampleState> {
  protected createState(): SampleState {
    return new SampleState();
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
    const options = this.#options;
    if (options.mode === "count") {
      // Count up to `every`, then reset and pass. Resetting (rather than an
      // ever-growing counter with a modulo) keeps the count bounded, so a
      // long-lived high-frequency route never drifts past Number.MAX_SAFE_INTEGER
      // where `count + 1 === count` would freeze the sampler.
      state.count += 1;
      if (state.count >= options.every) {
        state.count = 0;
        return true;
      }
      return false;
    }
    const now = Date.now();
    if (
      state.lastPassedAt === undefined ||
      now - state.lastPassedAt >= options.intervalMs
    ) {
      state.lastPassedAt = now;
      return true;
    }
    return false;
  }
}
