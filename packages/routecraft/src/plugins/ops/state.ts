/**
 * Health state for one context.
 *
 * Pure and framework-free on purpose: it deals in route-id strings and its own
 * types, never in context or adapter modules. The plugin translates framework
 * events into calls here; this file holds the judgement and is unit-tested in
 * isolation with an injected clock.
 *
 * What health answers is deliberately narrow: can this component serve at all?
 * A route is `down` only when it is not running (its source gave up) and
 * `degraded` only when a circuit breaker is holding calls off or it was taken
 * offline on purpose. The outcome of an individual exchange never decides it.
 * A refused caller, a validation error, or a business rule saying no are all a
 * running route behaving correctly, and paging on them turns every scope gap
 * and every malformed request into an incident. Those outcomes are still
 * counted, and the count still surfaces in `details` so a human reading the
 * report can see a route that is serving badly; they just do not change its
 * status. Escalating repeated failure into a health signal is the circuit
 * breaker's job, because only the breaker knows which errors it counts
 * (routecraft excludes non-retryable ones, so authorization failures cannot
 * trip it) and only the breaker actually stops the route serving.
 */

import type {
  CircuitState,
  HealthChange,
  ContextState,
  FailureDomain,
  Health,
  HealthComponent,
  HealthDetails,
  HealthReport,
  HealthStatus,
  HealthView,
  RouteLifecycle,
} from "./types";

/** Reserved route key for context-level errors that carry no route. */
const CONTEXT_KEY = "__context__";

export interface HealthStateOptions {
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called when a component's status changes, so the plugin can emit an event
   * without the ledger knowing what an event is.
   *
   * Transitions are detected per component as it mutates rather than by
   * re-deriving the whole report, so a hot route emitting one event per
   * exchange costs a single status comparison rather than a walk of every
   * component.
   *
   * Staleness is the exception: it is a function of elapsed time rather than
   * of any call, so an indicator going stale surfaces on the next report and
   * not as a transition.
   */
  onChange?: (change: HealthChange) => void;
}

interface RouteRecord {
  lifecycle: RouteLifecycle;
  /**
   * Breakers currently holding calls off, by label (`"route"` for a
   * route-scope breaker). Empty is the healthy case. Tracked per label because
   * a route may wrap several steps in their own.
   */
  breakers: Map<string, CircuitState>;
  /**
   * Consecutive failed exchanges. Diagnostic only: it explains a route that is
   * serving badly, and never decides that the route is unhealthy.
   */
  consecutiveFailures: number;
  /** Whether this route has ever completed an exchange successfully. */
  everSucceeded: boolean;
  /** Last status reported to `onChange`, so a transition is detected in O(1). */
  lastStatus: HealthStatus;
}

interface IndicatorRecord {
  maxAgeMs?: number;
  domain: FailureDomain;
  /** Set once the context reports started, which is when staleness starts counting. */
  startedAt?: number;
  lastReportAt?: number;
  lastHealth?: Health;
  inactive: boolean;
  /** Last status reported to `onChange`, so a transition is detected in O(1). */
  lastStatus: HealthStatus;
}

/**
 * Map a route's lifecycle and breakers onto the status vocabulary.
 *
 * Only `failed` is `down`: the route is not running, so nothing it is meant to
 * serve is being served. An open breaker is `degraded` instead, because the
 * route is live and the breaker is expected to close again on its own. So is a
 * route deliberately taken offline, which makes reduced capability visible in
 * the aggregate without paging. A route that ran once and closed, or was
 * stopped cleanly, reports `inactive`: still listed (so "did it run?" is
 * answerable) but excluded from aggregation.
 *
 * Recent exchange failures ride along in `details` whatever the status, since
 * "up, but its last four calls failed" is the report a human actually needs,
 * and is precisely the thing that must not page.
 */
/**
 * A route's status, without building its details map.
 *
 * Split from {@link routeComponent} because transition detection runs on every
 * exchange: allocating a details object per exchange to read one field off it
 * is GC churn on the framework's hottest path.
 */
function routeStatus(record: RouteRecord): HealthStatus {
  const { lifecycle, breakers } = record;
  if (lifecycle === "failed") return "down";
  if (lifecycle === "offline") return "degraded";
  if (lifecycle === "running") return breakers.size > 0 ? "degraded" : "up";
  return "inactive";
}

function routeComponent(record: RouteRecord): HealthComponent {
  const { lifecycle, breakers } = record;
  const details: HealthDetails = { lifecycle };

  if (breakers.size > 0) {
    details["circuit"] = [...breakers.values()].includes("open")
      ? "open"
      : "half-open";
    details["breakers"] = [...breakers.keys()].sort().join(",");
  }
  if (record.consecutiveFailures > 0) {
    details["failures"] = record.consecutiveFailures;
  }

  // Routes are always deployment-domain: derotating one instance cannot
  // redirect work that every replica would fail at identically, and no route
  // can declare otherwise in this version.
  const domain: FailureDomain = "deployment";

  return { status: routeStatus(record), domain, details };
}

/** Whether a component belongs in a given view. */
function includedIn(view: HealthView, component: HealthComponent): boolean {
  return view === "all" || component.domain === "instance";
}

/**
 * Aggregates route and indicator health, and projects it into views.
 *
 * Both push (indicators report up or down when they run) and event-derived
 * (routes are tracked from the framework's lifecycle and exchange events).
 * There is no scheduled check: in routecraft the idiomatic periodic worker is
 * a route, so dependency probes are routes that push into an indicator here.
 *
 * One ledger backs every view. What differs between them is only which
 * components they cover, decided by failure domain, so readiness can carry a
 * routing signal while operational health carries an alerting one without the
 * two states ever drifting apart.
 */
export class HealthState {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly indicators = new Map<string, IndicatorRecord>();
  private readonly now: () => number;
  private readonly onChange: (change: HealthChange) => void;
  private contextState: ContextState = "starting";
  private lastContextStatus: HealthStatus = "down";

  constructor(options: HealthStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  /** Emit a transition for one route, if its status moved. */
  private settleRoute(name: string, record: RouteRecord): void {
    const next = routeStatus(record);
    if (next === record.lastStatus) return;
    const from = record.lastStatus;
    record.lastStatus = next;
    this.onChange({ component: "route", name, from, to: next });
  }

  /** Emit a transition for one indicator, if its status moved. */
  private settleIndicator(name: string, record: IndicatorRecord): void {
    const next = this.indicatorComponent(record).status;
    if (next === record.lastStatus) return;
    const from = record.lastStatus;
    record.lastStatus = next;
    this.onChange({ component: "indicator", name, from, to: next });
  }

  /** Emit a transition for the context component, if its status moved. */
  private settleContext(): void {
    const next = this.contextComponent().status;
    if (next === this.lastContextStatus) return;
    const from = this.lastContextStatus;
    this.lastContextStatus = next;
    this.onChange({ component: "context", name: "context", from, to: next });
  }

  /**
   * The context finished starting: every route has subscribed, so this
   * instance can serve. Until this fires, readiness refuses traffic.
   */
  contextStarted(): void {
    this.contextState = "started";
    const at = this.now();
    for (const record of this.indicators.values()) {
      record.startedAt ??= at;
    }
    this.settleContext();
  }

  /**
   * Shutdown began. Readiness refuses traffic immediately, before any route is
   * torn down, so a load balancer stops sending work while in-flight exchanges
   * drain rather than during the teardown.
   */
  contextStopping(): void {
    this.contextState = "stopping";
    this.settleContext();
  }

  /** Shutdown finished. */
  contextStopped(): void {
    this.contextState = "stopped";
    this.settleContext();
  }

  /** Where the app is in its serving lifecycle. */
  get lifecycle(): ContextState {
    return this.contextState;
  }

  /** A route started (or restarted): it is running with a clean slate. */
  routeStarted(routeId: string): void {
    // Carry the previous status across the reset. Without it a route that died
    // and restarted compares up against a freshly initialised up and emits no
    // transition, leaving an alert opened by the down event never closed.
    const previous = this.routes.get(routeId)?.lastStatus ?? "up";
    const record: RouteRecord = {
      lifecycle: "running",
      breakers: new Map(),
      consecutiveFailures: 0,
      everSucceeded: false,
      lastStatus: previous,
    };
    this.routes.set(routeId, record);
    this.settleRoute(routeId, record);
  }

  /**
   * A route stopped. A one-shot that ran and succeeded is `completed`, one
   * that did nothing is `stopped`, and both are fine: a route closing is not a
   * failure. A route already judged `failed` or `offline` keeps that
   * disposition.
   */
  routeStopped(routeId: string): void {
    const record = this.routes.get(routeId);
    if (!record) return;
    if (record.lifecycle === "failed" || record.lifecycle === "offline") return;
    record.lifecycle = record.everSucceeded ? "completed" : "stopped";
    this.settleRoute(routeId, record);
  }

  /**
   * Mark a route deliberately out of service. Reports `degraded`, so the
   * aggregate shows reduced capability without paging, restarting, or
   * derotating anything.
   */
  setRouteOffline(routeId: string, offline: boolean): void {
    const record = this.routes.get(routeId);
    if (!record) return;
    record.lifecycle = offline ? "offline" : "running";
    if (!offline) record.consecutiveFailures = 0;
    this.settleRoute(routeId, record);
  }

  /**
   * A source gave up producing, so the route is no longer running. This is the
   * genuine liveness signal: nothing this route serves is being served, and no
   * exchange outcome can say the same. Without a route id it is context-level.
   */
  sourceDied(routeId: string | undefined): void {
    const id = routeId ?? CONTEXT_KEY;
    const record = this.ensureRoute(id);
    record.lifecycle = "failed";
    this.settleRoute(id, record);
  }

  /** An exchange completed: the route is serving, so its failure run resets. */
  exchangeCompleted(routeId: string): void {
    const record = this.ensureRoute(routeId);
    if (record.lifecycle !== "offline") record.lifecycle = "running";
    record.everSucceeded = true;
    record.consecutiveFailures = 0;
    this.settleRoute(routeId, record);
  }

  /**
   * An exchange failed. Counted, never escalated: the route is still running
   * and still serving, and this one caller got an error. Whether that error
   * was a dead upstream or a caller asking for something they may not have is
   * not a distinction health can draw, so it draws none and reports the
   * failure as context on a route that stays `up`.
   */
  exchangeFailed(routeId: string): void {
    this.ensureRoute(routeId).consecutiveFailures += 1;
  }

  /**
   * A circuit breaker tripped or is probing recovery: calls are being held
   * off, so the route is degraded until it closes again.
   *
   * @param routeId - The route the breaker belongs to.
   * @param label - The breaker's label, `"route"` for a route-scope breaker.
   *   Tracked per label because several breakers may be open at once.
   */
  circuitOpened(routeId: string, label: string, state: CircuitState): void {
    const record = this.ensureRoute(routeId);
    record.breakers.set(label, state);
    this.settleRoute(routeId, record);
  }

  /** A breaker recovered: it stops holding the route degraded. */
  circuitClosed(routeId: string, label: string): void {
    const record = this.routes.get(routeId);
    if (!record) return;
    record.breakers.delete(label);
    this.settleRoute(routeId, record);
  }

  /**
   * Register an indicator. Registering also makes it appear in reports
   * immediately (as healthy, then stale if it never reports), so a probe route
   * that never runs is itself a signal.
   */
  registerIndicator(
    name: string,
    options: { maxAgeMs?: number; domain?: FailureDomain } = {},
  ): void {
    this.indicators.set(name, {
      ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
      domain: options.domain ?? "deployment",
      ...(this.contextState === "started" ? { startedAt: this.now() } : {}),
      inactive: false,
      lastStatus: "up",
    });
  }

  /** Whether an indicator of this name is registered on this ledger. */
  hasIndicator(name: string): boolean {
    return this.indicators.has(name);
  }

  /** Record an indicator report. Any report clears a prior `inactive` marker. */
  reportIndicator(name: string, health: Health): void {
    const record = this.indicators.get(name);
    if (!record) return;
    record.lastReportAt = this.now();
    record.lastHealth = health;
    record.inactive = false;
    this.settleIndicator(name, record);
  }

  /** Park an indicator (maintenance): reports `inactive` and never pages. */
  setIndicatorInactive(name: string, inactive: boolean): void {
    const record = this.indicators.get(name);
    if (!record) return;
    record.inactive = inactive;
    this.settleIndicator(name, record);
  }

  /**
   * Produce a report over one view.
   *
   * @param view - `all` for the operational report (everything, read by humans
   *   and monitors), `readiness` for the routing signal (instance-domain
   *   components only). Defaults to `all`.
   *
   * The readiness view is often just the context component, and that is the
   * designed outcome rather than an oversight: nothing else qualifies until a
   * component declares that its failures really are local to one replica. The
   * context component alone still makes the view meaningful, because it is
   * what refuses traffic during boot and drain.
   */
  report(view: HealthView = "all"): HealthReport {
    const routes: Record<string, HealthComponent> = {};
    for (const [id, record] of this.routes) {
      const component = routeComponent(record);
      if (includedIn(view, component)) routes[id] = component;
    }

    const indicators: Record<string, HealthComponent> = {};
    for (const [name, record] of this.indicators) {
      const component = this.indicatorComponent(record);
      if (includedIn(view, component)) indicators[name] = component;
    }

    const context = this.contextComponent();
    const components = [
      context,
      ...Object.values(routes),
      ...Object.values(indicators),
    ].filter((component) => component.status !== "inactive");

    const anyDown = components.some((c) => c.status === "down");
    const anyDegraded = components.some((c) => c.status === "degraded");
    const status: HealthStatus = anyDown
      ? "down"
      : anyDegraded
        ? "degraded"
        : "up";

    return { view, ready: !anyDown, status, context, routes, indicators };
  }

  /** One route's component, or `undefined` if no such route is tracked. */
  routeComponentOf(routeId: string): HealthComponent | undefined {
    const record = this.routes.get(routeId);
    return record ? routeComponent(record) : undefined;
  }

  /** One indicator's component, or `undefined` if no such indicator exists. */
  indicatorComponentOf(name: string): HealthComponent | undefined {
    const record = this.indicators.get(name);
    return record ? this.indicatorComponent(record) : undefined;
  }

  /** Where a route is in its life, or `undefined` if it is not tracked. */
  routeLifecycle(routeId: string): RouteLifecycle | undefined {
    return this.routes.get(routeId)?.lifecycle;
  }

  /**
   * The app's serving lifecycle as a component.
   *
   * Always `instance` domain: whether this process has finished booting or has
   * begun draining says nothing about its peers, and it is exactly the case
   * where moving traffic elsewhere is the right response.
   */
  private contextComponent(): HealthComponent {
    return {
      status: this.contextState === "started" ? "up" : "down",
      domain: "instance",
      details: { state: this.contextState },
    };
  }

  /**
   * The record for a route, created if the event arrived before
   * `route:started` (or without one at all, as a context-level source failure
   * does). A route first seen this way is assumed running, since something
   * produced an event for it.
   */
  private ensureRoute(routeId: string): RouteRecord {
    const existing = this.routes.get(routeId);
    if (existing) return existing;
    const record: RouteRecord = {
      lifecycle: "running",
      breakers: new Map(),
      consecutiveFailures: 0,
      everSucceeded: false,
      lastStatus: "up",
    };
    this.routes.set(routeId, record);
    return record;
  }

  /**
   * Project an indicator record, applying staleness.
   *
   * An indicator with no `maxAgeMs` never goes stale: it is only as fresh as
   * its last push, which is the right reading for one fed by a business route
   * that may be idle for hours. Staleness is measured from the last report,
   * or from `context:started` when it has never reported, so a slow first
   * probe does not read as a dead dependency during boot.
   */
  private indicatorComponent(record: IndicatorRecord): HealthComponent {
    const { domain } = record;
    if (record.inactive) return { status: "inactive", domain };

    const now = this.now();
    const { maxAgeMs } = record;

    if (record.lastReportAt === undefined) {
      if (maxAgeMs === undefined) return { status: "up", domain };
      const since = record.startedAt ?? now;
      const age = now - since;
      return age > maxAgeMs
        ? {
            status: "down",
            domain,
            ageMs: age,
            details: { reason: "no-report" },
          }
        : { status: "up", domain, ageMs: age, details: { booting: true } };
    }

    const age = now - record.lastReportAt;
    const last = record.lastHealth ?? { status: "up" as const };
    const carried = last.details !== undefined ? { details: last.details } : {};
    if (last.status === "down") {
      return { status: "down", domain, ageMs: age, ...carried };
    }
    if (maxAgeMs !== undefined && age > maxAgeMs) {
      return {
        status: "down",
        domain,
        ageMs: age,
        details: { reason: "stale" },
      };
    }
    return { status: last.status, domain, ageMs: age, ...carried };
  }
}
