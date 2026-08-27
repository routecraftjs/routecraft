import type { Cron as CronType } from "croner";
import { loadOptionalPeer } from "./adapters/shared/optional-peer.ts";
import type { CronExpression } from "./adapters/cron/types.ts";
import { type Duration, parseDuration } from "./shared/duration.ts";

/**
 * What an {@link EnablementPredicate} answers with.
 *
 * `true` enables the route. A string disables it and IS the reason, so ops
 * can report why without the author declaring the reason a second time
 * (which is the declaration that goes stale). `false` disables it with a
 * generic reason, for a predicate that has nothing useful to add.
 */
export type EnablementVerdict = boolean | string;

/**
 * Decides whether a route runs.
 *
 * Evaluated once as the context starts, and again on the cadence the route
 * declared via {@link EnablementOptions.refresh}. It is per-route lifecycle,
 * not per-exchange filtering: it never sees an exchange and never runs on
 * the hot path.
 *
 * A predicate that throws leaves the route disabled with the error message
 * as its reason and never fails the boot. A capability whose credentials are
 * missing is a configuration state, and a configuration state must not take
 * the process down.
 */
export type EnablementPredicate = () =>
  EnablementVerdict | Promise<EnablementVerdict>;

/**
 * How often a route's predicate is re-evaluated.
 *
 * A {@link Duration} is a fixed interval; a cron expression is a schedule.
 * They are told apart by shape rather than by a mode flag: every cron
 * expression contains a space or starts with `@`, and no `Duration` does.
 */
export type RefreshCadence = Duration | CronExpression;

/** Options for the second argument of `.enabled()`. */
export interface EnablementOptions {
  /**
   * Re-evaluate the predicate on this cadence.
   *
   * Omitted (the default) is MANUAL: the predicate runs once as the route
   * starts and never again until something explicitly asks. That keeps the
   * common case, an environment variable that cannot change without a
   * restart, free of any recurring cost, and it stops a predicate that
   * reaches the network from becoming an invisible repeating one.
   */
  refresh?: RefreshCadence;
}

/**
 * A route's enablement declaration, as stored on its definition.
 *
 * @internal The shape is internal; declare it with `.enabled()`.
 */
export interface RouteEnablement {
  readonly predicate: EnablementPredicate;
  readonly refresh?: RefreshCadence;
}

/**
 * Where a route stands: enabled, or disabled with the reason ops reports.
 *
 * A discriminated union rather than a `{ enabled, reason? }` pair so a
 * reader cannot consult `reason` on an enabled route, and so the disabled
 * arm can never be constructed without one.
 */
export type EnablementState =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

/** Reason recorded when a predicate returns a bare `false`. */
export const DEFAULT_DISABLED_REASON =
  "the route's enabled() predicate returned false";

/**
 * Whether a refresh cadence is a cron schedule rather than an interval.
 *
 * Shape alone decides it. A cron expression is either a nickname (`@daily`)
 * or whitespace-separated fields; a `Duration` is a number or a single
 * unit-suffixed token, so neither form can be mistaken for the other.
 */
export function isCronCadence(
  refresh: RefreshCadence,
): refresh is CronExpression {
  return (
    typeof refresh === "string" &&
    (refresh.startsWith("@") || /\s/.test(refresh.trim()))
  );
}

/**
 * Run a route's predicate and turn whatever it did into an
 * {@link EnablementState}.
 *
 * Total by construction: every return value, and every throw, maps onto a
 * state. Nothing here rethrows, because the caller is the boot path and a
 * predicate is not allowed to fail it.
 *
 * @param enablement - The route's declaration.
 * @returns The resolved state. Never rejects.
 */
export async function evaluateEnablement(
  enablement: RouteEnablement,
): Promise<EnablementState> {
  try {
    const verdict = await enablement.predicate();
    if (verdict === true) return { enabled: true };
    if (verdict === false) {
      return { enabled: false, reason: DEFAULT_DISABLED_REASON };
    }
    if (typeof verdict === "string") {
      const reason = verdict.trim();
      return {
        enabled: false,
        reason: reason === "" ? DEFAULT_DISABLED_REASON : reason,
      };
    }
    // A JS caller returning a number, null or an object: treat anything that
    // is not an explicit `true` as "not enabled" rather than coercing. A
    // truthy object silently enabling a route whose credentials are absent
    // is the exact failure this feature exists to prevent.
    return {
      enabled: false,
      reason: `the route's enabled() predicate returned ${typeof verdict}, which is not a boolean or a reason string`,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    return {
      enabled: false,
      reason: `the route's enabled() predicate threw: ${message}`,
    };
  }
}

/**
 * Resolve a refresh cadence into the milliseconds an interval should use.
 *
 * @throws RC5003 when the value is neither a cron expression nor a usable
 *   duration.
 */
export function refreshIntervalMs(refresh: Duration, routeId: string): number {
  return parseDuration(refresh, `route "${routeId}" .enabled({ refresh })`);
}

/**
 * Load `croner`, the same optional peer the `cron()` adapter uses.
 *
 * Loaded lazily and only for a route that actually declared a cron refresh,
 * so a context whose routes all use the default manual cadence never pays
 * for a dependency it does not use. Kept as a static field for the same
 * reason the cron source does: tests replace it without touching the
 * module registry.
 *
 * @internal
 */
export const loadCronDriver: { current: () => Promise<typeof CronType> } = {
  current: () =>
    loadOptionalPeer(() => import("croner"), {
      consumer: "route .enabled({ refresh }) cron cadence",
      packageName: "croner",
    }).then((m) => m.Cron),
};

/**
 * Owns every route's enablement state, its refresh cadence, and the
 * transitions between the two states.
 *
 * The context owns one of these. It is deliberately the ONLY thing that
 * decides whether a route is running for enablement reasons: ops reads its
 * state, the capability surface filters on it, and the refresh timers drive
 * it. Splitting the refresh scheduler into its own plugin stays attractive
 * for keeping core lean and is a follow-up, not a reason to spread the
 * decision across two owners now.
 *
 * @internal The class is internal; reach it through `CraftContext`.
 */
export class RouteEnablementCoordinator {
  readonly #states = new Map<string, EnablementState>();
  readonly #intervals = new Map<string, ReturnType<typeof setInterval>>();
  readonly #crons = new Map<string, CronType>();
  #stopped = false;

  /**
   * @param deps - The context's own capabilities, injected rather than
   *   imported so this file stays testable without building a context and
   *   free of a cycle back into `context.ts`.
   */
  constructor(private readonly deps: EnablementDeps) {}

  /**
   * Every route's state, for ops and for the capability filter. A route with
   * no `.enabled()` never appears here; absent means enabled.
   */
  stateOf(routeId: string): EnablementState | undefined {
    return this.#states.get(routeId);
  }

  /** Whether this route may run. True for a route that never declared one. */
  isEnabled(routeId: string): boolean {
    return this.#states.get(routeId)?.enabled !== false;
  }

  /** Every disabled route, id to reason. Ops renders this. */
  disabled(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const [id, state] of this.#states) {
      if (!state.enabled) out.set(id, state.reason);
    }
    return out;
  }

  /**
   * Evaluate the declaring routes once, before any route starts.
   *
   * Run as a batch ahead of the boot rather than per route inside it, so one
   * slow predicate delays only the decision and never sits between two
   * unrelated routes starting.
   *
   * Takes the ALREADY-FILTERED list rather than filtering here, because the
   * caller must be able to skip this call entirely: awaiting it is an extra
   * turn on the boot path, and a context whose routes declare no predicate
   * must not pay one (a `start()` racing a `stop()` interleaves differently
   * across that turn).
   *
   * @param declaring - Routes that declared `.enabled()`. Nothing else.
   * @returns The ids that must NOT be started.
   */
  async evaluateForBoot(
    declaring: ReadonlyArray<EnablementRoute>,
  ): Promise<ReadonlySet<string>> {
    await Promise.all(
      declaring.map(async (route) => {
        const enablement = route.definition.enablement;
        if (!enablement) return;
        const state = await evaluateEnablement(enablement);
        this.#record(route, state);
      }),
    );
    const skip = new Set<string>();
    for (const [id, state] of this.#states) {
      if (!state.enabled) skip.add(id);
    }
    return skip;
  }

  /**
   * Arm the refresh cadences, once the boot has settled.
   *
   * Separate from {@link RouteEnablementCoordinator.evaluateForBoot} because
   * a timer armed before the routes are up could fire a transition into a
   * context that is still starting.
   */
  startRefreshing(routes: ReadonlyArray<EnablementRoute>): void {
    if (this.#stopped) return;
    for (const route of routes) {
      const refresh = route.definition.enablement?.refresh;
      if (refresh === undefined) continue;
      if (isCronCadence(refresh)) {
        void this.#armCron(route, refresh);
      } else {
        const ms = refreshIntervalMs(refresh, route.definition.id);
        const timer = setInterval(() => {
          void this.refresh(route);
        }, ms);
        // A refresh cadence must not be the reason a process stays alive:
        // the routes decide that, and a context whose routes have all
        // finished should exit rather than idle on a poll timer.
        timer.unref?.();
        this.#intervals.set(route.definition.id, timer);
      }
    }
  }

  /**
   * Re-evaluate one route's predicate now and apply any transition.
   *
   * This is the internal control surface the deferred ops re-evaluate
   * endpoint will call: the operator sets the secret, asks for a re-check,
   * and the route comes up without a process restart. Adding that endpoint
   * is wiring rather than redesign precisely because this exists.
   *
   * @returns The state after the re-evaluation.
   */
  async refresh(route: EnablementRoute): Promise<EnablementState> {
    const enablement = route.definition.enablement;
    if (!enablement) return { enabled: true };
    if (this.#stopped) {
      return this.#states.get(route.definition.id) ?? { enabled: true };
    }
    const next = await evaluateEnablement(enablement);
    const previous = this.#states.get(route.definition.id);
    this.#record(route, next);
    if (previous === undefined || previous.enabled === next.enabled) {
      return next;
    }
    if (next.enabled) {
      await this.#enable(route);
    } else {
      await this.#disable(route, next.reason);
    }
    return next;
  }

  /** Re-evaluate every declaring route. The all-routes control surface. */
  async refreshAll(
    routes: ReadonlyArray<EnablementRoute>,
  ): Promise<ReadonlyMap<string, EnablementState>> {
    await Promise.all(
      routes
        .filter((r) => r.definition.enablement)
        .map((route) => this.refresh(route)),
    );
    return new Map(this.#states);
  }

  /**
   * Drop every refresh timer. Called from context shutdown, before the
   * routes are torn down, so no transition can start against a context that
   * is on its way out.
   */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#intervals.values()) clearInterval(timer);
    this.#intervals.clear();
    for (const cron of this.#crons.values()) cron.stop();
    this.#crons.clear();
  }

  /**
   * Take a running route out of service: stop intake, let in-flight
   * exchanges finish, then abandon whatever is left once the grace deadline
   * passes.
   *
   * Exactly what shutdown does per route, through the same two signals, for
   * the same reason: a flag flip must never be a data-loss event. There is
   * deliberately no second stop path.
   */
  async #disable(route: EnablementRoute, reason: string): Promise<void> {
    this.deps
      .logger()
      .info(
        { route: route.definition.id, reason },
        "Route disabled by its enabled() predicate; draining",
      );
    // Stage one: intake only. Work already in the pipeline runs to its
    // natural end, which is the whole difference between a drain and a
    // cancellation.
    this.deps.abortIntake(route.definition.id, `disabled: ${reason}`);
    // Stage two: the grace deadline the context already applies to
    // shutdown. Read from the context so one knob governs both, rather
    // than enablement inventing a second timeout an operator has to find.
    const drained = await this.deps.drainWithin(route);
    if (!drained) {
      route.abortExecution(`disabled: ${reason}`);
    }
  }

  /** Bring a disabled route up: re-arm it, then start it normally. */
  async #enable(route: EnablementRoute): Promise<void> {
    this.deps
      .logger()
      .info(
        { route: route.definition.id },
        "Route enabled by its enabled() predicate; starting",
      );
    try {
      await this.deps.startRoute(route);
    } catch (err) {
      // A route that could not start is a FAILED route, not a disabled one,
      // and the two must stay distinct: disabled is a deliberate
      // configuration state that never pages, and reporting a broken start
      // as disabled would hide a real incident behind it. Leave the state
      // enabled and let the route's own failure path report it.
      this.deps
        .logger()
        .error(
          { route: route.definition.id, err },
          "Route was re-enabled but failed to start",
        );
    }
  }

  /** Store the state and announce a genuine change. */
  #record(route: EnablementRoute, state: EnablementState): void {
    const previous = this.#states.get(route.definition.id);
    this.#states.set(route.definition.id, state);
    // Only a real transition is announced. A five-minute cadence over a
    // stable predicate would otherwise emit a heartbeat that every listener
    // has to filter, and the one event that matters would be lost in it.
    if (previous !== undefined && previous.enabled === state.enabled) return;
    this.deps.emitChanged(
      route,
      state.enabled,
      state.enabled ? undefined : state.reason,
    );
  }

  /** Arm a cron cadence, loading `croner` only for a route that wants one. */
  async #armCron(
    route: EnablementRoute,
    expression: CronExpression,
  ): Promise<void> {
    try {
      const Cron = await loadCronDriver.current();
      if (this.#stopped) return;
      this.#crons.set(
        route.definition.id,
        new Cron(expression, () => {
          void this.refresh(route);
        }),
      );
    } catch (err) {
      // A refresh cadence that cannot be armed leaves the route on whatever
      // its boot evaluation decided. That is a degraded cadence, not a
      // broken route, so it warns rather than failing the context: the
      // alternative is a missing optional peer taking down a process whose
      // routes are all working.
      this.deps
        .logger()
        .warn(
          { route: route.definition.id, expression, err },
          "Could not arm the cron refresh cadence; the route keeps its current enablement state",
        );
    }
  }
}

/** The subset of a route the coordinator touches. @internal */
export interface EnablementRoute {
  readonly definition: {
    readonly id: string;
    readonly enablement?: RouteEnablement;
  };
  abortExecution(reason?: unknown): void;
}

/**
 * What the coordinator needs from its context, injected at construction.
 *
 * An interface rather than a `CraftContext` so this module does not import
 * the context that owns it, and so the transitions can be driven directly
 * in a test.
 *
 * @internal
 */
export interface EnablementDeps {
  logger(): {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  /** Fire the route's intake signal: stop accepting, keep running. */
  abortIntake(routeId: string, reason: string): void;
  /** Wait out the shutdown grace period. False when it elapsed first. */
  drainWithin(route: EnablementRoute): Promise<boolean>;
  /** Re-arm and start a route that was disabled. */
  startRoute(route: EnablementRoute): Promise<void>;
  emitChanged(route: EnablementRoute, enabled: boolean, reason?: string): void;
}
