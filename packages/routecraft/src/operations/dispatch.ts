import { LRUCache } from "lru-cache";
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
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { type Path, compilePath } from "./choice.ts";
import { RouteScopedController } from "./route-scoped-controller.ts";
import { DEFAULT_MAX_KEYS, validateMaxKeys } from "./max-keys.ts";

/**
 * Name of a dispatch selection strategy. Surfaced on the
 * `route:operation:dispatch:selected` event so observers can attribute a
 * pick to the strategy that made it.
 */
export type DispatchStrategyName =
  | "failover"
  | "round-robin"
  | "weighted"
  | "sticky";

/**
 * Strategy argument accepted as the required leading parameter of
 * `.dispatch(strategy, ...targets)`. There is no safe default strategy
 * (each makes a materially different routing decision), so it is required.
 *
 * - String form for the strategies that carry no extra configuration:
 *   `"failover"`, `"round-robin"`, `"weighted"`.
 * - Object form when the strategy needs config. `sticky` REQUIRES a `key`
 *   selector (it has nothing to partition on otherwise) and so has no string
 *   form, and accepts an optional `maxKeys` bound on the affinity map.
 *
 * @template In - Body type of the exchange at the point of the dispatch
 */
export type DispatchStrategy<In = unknown> =
  | "failover"
  | "round-robin"
  | "weighted"
  | { strategy: "failover" | "round-robin" | "weighted" }
  | {
      strategy: "sticky";
      /** Partition selector: exchanges sharing a key stick to one target. */
      key: (exchange: Exchange<In>) => string;
      /**
       * Maximum number of distinct keys retained in the affinity map (an
       * LRU). When the cap is reached the least-recently-seen key is evicted
       * and its next occurrence is reassigned (possibly to a different
       * target). Default {@link DEFAULT_MAX_KEYS}.
       */
      maxKeys?: number;
    };

/**
 * Brand marking a {@link WeightedTarget}. A symbol (not a string field) so a
 * user destination or body can never collide with it, and so the wrapper is
 * invisible to ordinary property enumeration.
 */
const WEIGHTED = Symbol("routecraft.dispatch.weighted");

/**
 * A dispatch target with its relative weight co-located. Produced by
 * {@link weighted}; consumed only by the `weighted` strategy (other
 * strategies ignore the weight). Keeping the weight next to its target makes
 * the target list reorder-safe and mixable with un-weighted targets, which
 * default to weight 1.
 *
 * @template In  - Body type entering the target
 * @template Out - Body type the target produces (discarded; dispatch is
 *   side-effect-only)
 */
export interface WeightedTarget<In = unknown, Out = unknown> {
  readonly [WEIGHTED]: true;
  readonly weight: number;
  readonly path: Path<In, Out>;
}

/**
 * A single dispatch target: a bare destination, a sub-pipeline callback (the
 * shared {@link Path} surface), or either of those wrapped in a relative
 * {@link weighted} weight.
 *
 * @template In  - Body type entering the target
 * @template Out - Body type the target produces (discarded)
 */
export type DispatchTarget<In = unknown, Out = unknown> =
  | Path<In, Out>
  | WeightedTarget<In, Out>;

/**
 * Co-locate a relative weight with a dispatch target for the `weighted`
 * strategy. Weights are relative, not percentages, so `weighted(a, 3)` and
 * `weighted(b, 1)` send roughly three exchanges to `a` for each one to `b`.
 * Mixable with un-weighted targets, which take a default weight of 1.
 *
 * Rejected at build time (RC5003) if the weight is not a finite number > 0,
 * so a mis-typed weight fails when the route is built rather than silently
 * starving a target.
 *
 * @param path - The destination or sub-pipeline callback to weight
 * @param weight - Relative weight; must be a finite number > 0
 * @returns A weighted target consumed by `.dispatch("weighted", ...)`
 */
export function weighted<In = unknown, Out = unknown>(
  path: Path<In, Out>,
  weight: number,
): WeightedTarget<In, Out> {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw rcError("RC5003", undefined, {
      message: `weighted() weight must be a finite number > 0, got ${String(weight)}.`,
    });
  }
  return { [WEIGHTED]: true, weight, path };
}

/** Type guard: is this target a {@link weighted} wrapper rather than a bare path? */
function isWeighted(
  target: DispatchTarget<unknown, unknown>,
): target is WeightedTarget<unknown, unknown> {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as { [WEIGHTED]?: true })[WEIGHTED] === true
  );
}

/**
 * One compiled target: the step array to run plus its relative weight (1 for
 * an un-weighted target).
 *
 * @internal
 */
interface CompiledTarget {
  steps: Step<Adapter>[];
  weight: number;
}

/**
 * The selection strategy with its mode resolved and (for `sticky`) the key
 * selector and affinity bound validated.
 *
 * @internal
 */
type ResolvedDispatchStrategy =
  | { name: "failover" }
  | { name: "round-robin" }
  | { name: "weighted" }
  | {
      name: "sticky";
      key: (exchange: Exchange) => string;
      maxKeys: number;
    };

/**
 * Validate the leading strategy argument into a {@link ResolvedDispatchStrategy}.
 * Rejects at build time (RC5003) so a bad strategy (or a `sticky` missing its
 * `key`) fails when the route is built. The type already forbids these for
 * typed callers; the runtime checks defend JS callers and widened values.
 *
 * @internal
 */
export function resolveDispatchStrategy(
  strategy: DispatchStrategy<unknown>,
): ResolvedDispatchStrategy {
  const unknownStrategy = (name: unknown): never => {
    throw rcError("RC5003", undefined, {
      message: `dispatch() unknown strategy "${String(name)}"; expected "failover", "round-robin", "weighted", or { strategy: "sticky", key }.`,
    });
  };
  const requireStickyKey = (): never => {
    throw rcError("RC5003", undefined, {
      message:
        'dispatch({ strategy: "sticky" }) requires a `key` function to partition on (no string form).',
    });
  };

  if (typeof strategy === "string") {
    if (
      strategy === "failover" ||
      strategy === "round-robin" ||
      strategy === "weighted"
    ) {
      return { name: strategy };
    }
    // The type has no `"sticky"` string member (sticky has nothing to
    // partition on without a key), but a JS caller could still pass it: point
    // them at the object form rather than the generic unknown-strategy error.
    return String(strategy) === "sticky"
      ? requireStickyKey()
      : unknownStrategy(strategy);
  }

  if (strategy.strategy === "sticky") {
    if (typeof strategy.key !== "function") return requireStickyKey();
    const maxKeys = strategy.maxKeys ?? DEFAULT_MAX_KEYS;
    validateMaxKeys("dispatch", maxKeys);
    return { name: "sticky", key: strategy.key, maxKeys };
  }

  switch (strategy.strategy) {
    case "failover":
    case "round-robin":
    case "weighted":
      return { name: strategy.strategy };
    default:
      return unknownStrategy((strategy as { strategy?: unknown }).strategy);
  }
}

/**
 * Compile the variadic targets into their step arrays and weights. Rejects an
 * empty target list at build time (RC5003): a dispatch with nothing to select
 * between is meaningless.
 *
 * @internal
 */
export function compileDispatchTargets(
  targets: readonly DispatchTarget<unknown, unknown>[],
): CompiledTarget[] {
  if (targets.length === 0) {
    throw rcError("RC5003", undefined, {
      message: "dispatch() requires at least one target.",
    });
  }
  return targets.map((target) =>
    isWeighted(target)
      ? { steps: compilePath(target.path), weight: target.weight }
      : { steps: compilePath(target), weight: 1 },
  );
}

/**
 * Per-route dispatch state. One instance per Route (see
 * {@link DispatchController}), never one per exchange: the cursors and the
 * affinity map must persist across the exchanges a Route processes for the
 * strategies to mean anything.
 *
 * @internal
 */
class DispatchState {
  /** Round-robin: index of the next target to hand out. */
  rrCursor = 0;
  /**
   * Failover: index of the current preferred target. Starts at 0 and advances
   * only when the preferred target fails, so a healthy target keeps serving
   * without re-probing a dead one each exchange. Does not auto-revert.
   */
  failoverCursor = 0;
  /** Sticky: round-robins NEW keys across targets so affinity spreads evenly. */
  stickyCursor = 0;
  /** Weighted (smooth weighted round-robin): per-target running current weight. */
  readonly currentWeights: number[];
  /** Sticky: key -> target index affinity map, LRU-bounded by `maxKeys`. */
  readonly sticky: LRUCache<string, number>;

  constructor(targetCount: number, stickyMaxKeys: number) {
    this.currentWeights = new Array<number>(targetCount).fill(0);
    this.sticky = new LRUCache<string, number>({
      max: stickyMaxKeys,
      // A hit is a use: refresh recency so an actively-arriving key keeps its
      // affinity rather than being evicted ahead of colder keys.
      updateAgeOnGet: true,
    });
  }
}

/**
 * Owns the dispatch state for one `.dispatch()` across every Route the step
 * runs in (see {@link RouteScopedController}): each Route gets its own cursors
 * and affinity map so contexts cannot cross-route each other's traffic.
 *
 * @internal
 */
class DispatchController extends RouteScopedController<DispatchState> {
  readonly #targetCount: number;
  readonly #stickyMaxKeys: number;

  constructor(targetCount: number, stickyMaxKeys: number) {
    super();
    this.#targetCount = targetCount;
    this.#stickyMaxKeys = stickyMaxKeys;
  }

  protected createState(): DispatchState {
    return new DispatchState(this.#targetCount, this.#stickyMaxKeys);
  }
}

/** Marker adapter for the dispatch step; the targets live on the step itself. */
export interface DispatchAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.dispatch";
}

/**
 * Step that runs EXACTLY ONE of its targets, chosen by strategy, and lets the
 * original exchange continue downstream unchanged. The sibling of `multicast`
 * (all targets) and `choice` (one target by predicate); dispatch is one target
 * by load-balancing strategy.
 *
 * Side-effect-only: the selected target runs on its own deep clone (fresh id,
 * preserved correlation id), exactly like a multicast path, so a target that
 * reshapes the body does not change what continues downstream. There is no
 * branch-convergence requirement, so a target's output type is unconstrained.
 *
 * Strategies:
 * - `failover`: try targets in order from the current preferred cursor until
 *   one settles without failing (a target that deliberately drops the exchange
 *   counts as handled). On a failure, advance to the next target and retry; the
 *   cursor persists so a healthy target keeps serving and a dead one is not
 *   re-probed every exchange. If every target fails, emit
 *   `route:operation:dispatch:exhausted` and let the original continue. Pairs
 *   naturally with per-target `.retry()` / `.circuitBreaker()`.
 * - `round-robin`: hand out targets in order, cycling.
 * - `weighted`: smooth weighted round-robin over the `weighted()` weights, so
 *   the distribution matches the weights and is deterministic (testable)
 *   rather than random.
 * - `sticky`: exchanges sharing a `key` go to the same target; new keys are
 *   round-robined across targets and remembered in an LRU-bounded map.
 *
 * A failing target fires its own clone's error events (`route:error` /
 * `route:exchange:failed`) but never fails the route or the dispatch step
 * itself, matching multicast's isolation contract.
 */
export class DispatchStep<In = unknown> implements Step<DispatchAdapter> {
  operation: OperationType = OperationType.DISPATCH;
  adapter: DispatchAdapter = { adapterId: "routecraft.operation.dispatch" };

  readonly #strategy: ResolvedDispatchStrategy;
  readonly #targets: CompiledTarget[];
  readonly #weights: number[];
  readonly #controller: DispatchController;

  constructor(
    strategy: DispatchStrategy<In>,
    targets: readonly DispatchTarget<In, unknown>[],
  ) {
    this.#strategy = resolveDispatchStrategy(
      strategy as DispatchStrategy<unknown>,
    );
    this.#targets = compileDispatchTargets(
      targets as readonly DispatchTarget<unknown, unknown>[],
    );
    this.#weights = this.#targets.map((t) => t.weight);
    this.#controller = new DispatchController(
      this.#targets.length,
      this.#strategy.name === "sticky" ? this.#strategy.maxKeys : 1,
    );
  }

  async execute(
    exchange: Exchange<In>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // With no context there is nothing to run a target against; pass the
    // exchange through unchanged. In practice the executor always supplies a
    // context, so this is a defensive no-op (mirrors multicast).
    if (!context) {
      return { kind: "continue", exchange };
    }

    const state = this.#controller.stateFor(route);
    const n = this.#targets.length;

    if (this.#strategy.name === "failover") {
      for (let attempt = 0; attempt < n; attempt++) {
        const targetIndex = (state.failoverCursor + attempt) % n;
        context.emit("route:operation:dispatch:selected", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          strategy: "failover",
          targetIndex,
        });
        const result = await ctx.runPath({
          steps: this.#targets[targetIndex].steps,
          exchange: cloneExchange(exchange, context, route),
        });
        // A drop is a deliberate resolution (the target handled it and chose
        // to discard), not a failure: only a genuine failure fails over.
        if (!result.failed) {
          state.failoverCursor = targetIndex;
          return { kind: "continue", exchange };
        }
      }
      // Every target failed. Side-effect-only: the original still continues;
      // the exhausted event is the signal that no target handled it.
      context.emit("route:operation:dispatch:exhausted", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        strategy: "failover",
        targetCount: n,
      });
      return { kind: "continue", exchange };
    }

    const targetIndex = this.#select(state, exchange);
    context.emit("route:operation:dispatch:selected", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      strategy: this.#strategy.name,
      targetIndex,
    });
    // Run the selected target on its own clone and wait for it to settle
    // before the original continues, so ordering is deterministic. The
    // result is ignored: a non-failover target's failure stays isolated to
    // its clone's own error events, exactly like a multicast path.
    await ctx.runPath({
      steps: this.#targets[targetIndex].steps,
      exchange: cloneExchange(exchange, context, route),
    });
    return { kind: "continue", exchange };
  }

  /** Pick one target index for the non-failover strategies. */
  #select(state: DispatchState, exchange: Exchange<In>): number {
    const n = this.#targets.length;
    switch (this.#strategy.name) {
      case "round-robin": {
        const index = state.rrCursor % n;
        state.rrCursor = (state.rrCursor + 1) % n;
        return index;
      }
      case "weighted": {
        // Smooth weighted round-robin (the nginx algorithm): add each target's
        // weight to its running current, pick the max, then subtract the total
        // from the winner. Deterministic and evenly interleaved for any weights.
        let total = 0;
        let best = 0;
        for (let i = 0; i < n; i++) {
          state.currentWeights[i] += this.#weights[i];
          total += this.#weights[i];
          if (state.currentWeights[i] > state.currentWeights[best]) {
            best = i;
          }
        }
        state.currentWeights[best] -= total;
        return best;
      }
      case "sticky": {
        const key = this.#strategy.key(exchange);
        const existing = state.sticky.get(key);
        if (existing !== undefined) return existing;
        // New key: assign the next target round-robin so affinity spreads
        // evenly, then remember it (LRU-bounded by maxKeys).
        const index = state.stickyCursor % n;
        state.stickyCursor = (state.stickyCursor + 1) % n;
        state.sticky.set(key, index);
        return index;
      }
      default:
        // `failover` is handled in execute() and never reaches #select; the
        // other names are exhausted above. This guards a widened value.
        throw rcError("RC5001", undefined, {
          message: `dispatch() reached #select with unhandled strategy "${this.#strategy.name}".`,
        });
    }
  }
}

/**
 * Build the {@link DispatchStep} for a variadic `.dispatch(strategy, ...targets)`
 * call. Keeps the step value encapsulated in this module so the builder only
 * depends on the helper.
 *
 * @internal
 */
export function buildDispatchStep<In = unknown>(
  strategy: DispatchStrategy<In>,
  targets: readonly DispatchTarget<In, unknown>[],
): DispatchStep<In> {
  return new DispatchStep<In>(strategy, targets);
}
