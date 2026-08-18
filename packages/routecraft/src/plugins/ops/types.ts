/**
 * Public types for the ops plugin's health surface.
 *
 * The status vocabulary and the report shape are the external contract an
 * uptime monitor and an orchestrator match against, so both are add-only:
 * fields may be added, never removed or repurposed.
 */

/**
 * The four-member health vocabulary.
 *
 * - `up`: serving normally.
 * - `degraded`: serving with reduced capability. A circuit breaker is holding
 *   calls off, or the route was deliberately taken offline. Never pages.
 * - `down`: cannot serve at all. For a route this means its source gave up
 *   producing; nothing it exists to serve is being served.
 * - `inactive`: deliberately out of the picture. A finished one-shot route, a
 *   route stopped cleanly, or an indicator parked for maintenance. Excluded
 *   from aggregation entirely.
 *
 * New signals map into these rather than extending them; their richer state
 * belongs in the per-component `details` map.
 */
export type HealthStatus = "up" | "degraded" | "down" | "inactive";

/**
 * How widely a failure is felt, which decides whether readiness may carry it.
 *
 * - `instance`: this process or replica specifically. Peers may be fine, so
 *   taking this instance out of the load balancer's pool can genuinely help.
 * - `deployment`: every replica alike. Derotating one sends traffic to a peer
 *   that fails identically, so readiness must ignore it and only the
 *   operational signal may carry it.
 */
export type FailureDomain = "instance" | "deployment";

/**
 * Which components a report covers.
 *
 * - `readiness`: instance-domain components only, because the only thing
 *   acting on this view does is move traffic between replicas, which helps
 *   only when the peers are in a better position.
 * - `all`: every component, whatever its domain. The operational view, read by
 *   humans and monitors, which never influences routing.
 */
export type HealthView = "readiness" | "all";

/**
 * Where the app is in its own serving life, independent of whether any
 * dependency is healthy. This is the substance of readiness: during a deploy
 * a new container must not receive traffic until its routes are subscribed,
 * and during shutdown it must stop receiving before the process exits.
 */
export type ContextState = "starting" | "started" | "stopping" | "stopped";

/**
 * Where a route is in its life, independent of whether that is healthy.
 *
 * Routecraft routes are not all long-running: a one-shot source runs, does its
 * work, and closes. Without this distinction such a route would either look
 * permanently `up` (a lie) or trip readiness when it finished (a false page).
 *
 * - `running`: started, still live.
 * - `completed`: stopped after doing work successfully. A finished one-shot.
 * - `stopped`: stopped cleanly without ever succeeding (shutdown, or a source
 *   that had nothing to do).
 * - `offline`: deliberately disabled. Reports `degraded`, never pages.
 * - `failed`: not running when it should be. Its source gave up producing.
 */
export type RouteLifecycle =
  "running" | "completed" | "stopped" | "offline" | "failed";

/** A circuit breaker's position, mirroring routecraft's breaker events. */
export type CircuitState = "open" | "half-open";

/**
 * A component's status transition, as carried by `plugin:ops:health:changed`.
 *
 * Emitted as a component changes rather than derived by re-reading the whole
 * report, so an operator alerts on the transition instead of polling for it.
 */
export interface HealthChange {
  component: "context" | "route" | "indicator";
  /** The component's name; the reserved id `context` for the serving lifecycle. */
  name: string;
  from: HealthStatus;
  to: HealthStatus;
}

/**
 * A value allowed in a component's `details` map.
 *
 * Structural facts only: enums, numbers, booleans. Never an error message.
 * Health answers whether a component can serve; what went wrong and why is
 * carried by logs and telemetry, which are not readable by everyone who can
 * reach this endpoint.
 */
export type HealthDetailValue = string | number | boolean;

/** Component-owned diagnostic context. Structural facts only. */
export type HealthDetails = Record<string, HealthDetailValue>;

/** What a component reports. */
export interface Health {
  status: HealthStatus;
  details?: HealthDetails;
}

/** A component as it appears in a report. */
export interface HealthComponent extends Health {
  /**
   * How widely this component's failure is felt. Only `instance` components
   * appear in the readiness view.
   */
  domain: FailureDomain;
  /** Milliseconds since this component last reported. Indicators only. */
  ageMs?: number;
}

/**
 * A report body. This shape is the external contract, so it is add-only:
 * fields may be added, never removed or repurposed.
 *
 * `ready` is true when no component in the requested view is `down`. On
 * `/health` the view is every component, so `ready` there can be false while
 * `/health/ready` still answers 200. Nothing should route on the aggregate's
 * `ready`; that is what the readiness view is for.
 */
export interface HealthReport {
  /**
   * Which components this report covers. Carried on the body so a consumer
   * holding a report can tell the operational aggregate from the routing
   * signal, rather than having to remember which path produced it.
   */
  view: HealthView;
  ready: boolean;
  status: HealthStatus;
  /** The app's own serving lifecycle. Always present, always instance-domain. */
  context: HealthComponent;
  routes: Record<string, HealthComponent>;
  indicators: Record<string, HealthComponent>;
}

/** The liveness body. Deliberately carries no component state. */
export interface LivenessReport {
  status: "up";
  uptime: number;
}

/**
 * Exposure of the per-component `details` maps.
 *
 * - `always`: serve details to every caller.
 * - `when-authenticated`: serve details only to a caller the server's validator
 *   admits. On a server with no validator configured there is nothing to
 *   authenticate against, so this collapses to `always`, the same collapse the
 *   http plugin applies to its `/ready` built-in. Put the mount on a server
 *   that is not publicly reachable if that collapse is not what you want.
 * - `never`: never serve details.
 *
 * The gate withholds per-component diagnostics and nothing else. It does not
 * hide topology: component names are the keys of the always-served status
 * maps, and the per-component paths answer 404 for an unknown id in every
 * mode. An app that must not disclose its route inventory puts the ops
 * listener somewhere the public cannot reach it.
 */
export type HealthDetailsExposure = "always" | "when-authenticated" | "never";

/** Health endpoint configuration. */
export interface OpsHealthOptions {
  /** Exposure of per-component `details`. Defaults to `when-authenticated`. */
  details?: HealthDetailsExposure;
}

/** Options for {@link opsPlugin}. */
export interface OpsPluginOptions {
  /**
   * Named server (`defineConfig({ servers })`) to mount the health paths on.
   * Defaults to `"default"`.
   *
   * A dedicated ops port is a second named server the surface points at, which
   * is how an internal-only surface is expressed. Bind that server somewhere
   * the probes can reach: a Kubernetes `httpGet` probe comes from the kubelet
   * against the pod IP and a reverse-proxy check comes from the proxy, so
   * neither reaches `127.0.0.1`. Only a Docker `HEALTHCHECK`, which runs
   * inside the container, does. Keep the port private at the network layer
   * rather than by binding loopback.
   */
  server?: string;
  /** Health endpoint configuration. */
  health?: OpsHealthOptions;
  /** Indicators to register. See `defineIndicator`. */
  indicators?: readonly Indicator[];
}

/** The `ops` config key. */
export type OpsConfig = OpsPluginOptions;

/** How an indicator is declared. */
export interface IndicatorDefinition {
  /** Unique name. Becomes the key in the report and the path segment. */
  name: string;
  /**
   * No report within this window makes the indicator `down` (stale).
   *
   * Optional. With it, the indicator is expected on a cadence, which is right
   * for a probe route. Without it the indicator is only as fresh as its last
   * push, which is the correct reading for one fed from a business route that
   * may legitimately be idle for hours.
   */
  maxAgeMs?: number;
  /**
   * How widely this dependency's failure is felt. Defaults to `deployment`,
   * which is right for anything reached over the network with shared
   * credentials: every replica would fail the same way, so it must page
   * without ever moving traffic.
   */
  domain?: FailureDomain;
  /**
   * Bind this indicator to a route's exchange outcomes: a completed exchange
   * reports up, a failed exchange reports down, and no exchange within
   * `maxAgeMs` goes stale. The route needs no health code at all.
   *
   * For probe routes only, where the exchange is the health check by
   * construction. Binding a business route would make every expected refusal
   * (a caller without the scope, a validation error, a business rule saying
   * no) report the dependency down, which is the escalation this design
   * exists to prevent.
   */
  route?: string;
}

/**
 * A registered indicator: both the declaration and the push handle.
 *
 * Inert until an ops plugin binds it to a context. Ledgers are keyed by
 * context rather than held in a closure slot, so one module-scope handle
 * serves any number of live contexts.
 */
export interface Indicator {
  readonly name: string;
  readonly definition: Readonly<IndicatorDefinition>;
  /**
   * Report this dependency healthy.
   *
   * Anything passed in `details` is published on the health endpoint, which
   * may admit unauthenticated callers. Pass structural facts, never an error
   * message: `err.message` from a connection or auth failure routinely carries
   * hosts, usernames, and provider text. Log the error where it happened.
   */
  up(details?: HealthDetails): void;
  /**
   * Report this dependency unhealthy.
   *
   * The same rule as {@link Indicator.up}: `details` reaches the endpoint, so
   * it carries structural facts and never an error message.
   */
  down(details?: HealthDetails): void;
  /** Park the indicator: reports `inactive` and never pages until it reports again. */
  inactive(): void;
}
