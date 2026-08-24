/**
 * Public types for the ops plugin's health surface.
 *
 * The status vocabulary and the report shape are the external contract an
 * uptime monitor and an orchestrator match against, so both are add-only:
 * fields may be added, never removed or repurposed.
 */

import type { HttpAuth } from "../../adapters/http/types";
import type { Suspended } from "../../suspension/suspended";

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
 * There is deliberately no separate `ready` flag. It would be exactly
 * `status !== "down"` on whichever view produced the report, and a derivable
 * field named `ready` on the operational aggregate invites the one mistake
 * this design exists to prevent: routing traffic on the deployment-wide
 * signal. Read `status`, and read it from `/health/ready` when the answer
 * decides where traffic goes.
 */
export interface HealthReport {
  /**
   * Which components this report covers. Carried on the body so a consumer
   * holding a report can tell the operational aggregate from the routing
   * signal, rather than having to remember which path produced it.
   */
  view: HealthView;
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
 * - `when-authenticated`: serve details only to a caller the mount's
 *   effective validator admits (the ops mount's own `auth`, else the
 *   server's). Written explicitly with no validator in scope it fails the
 *   boot: the operator asked for a gate and there is nothing to gate with.
 *   As the unwritten default with no validator it collapses to `never`,
 *   with a startup warning naming the ways out: a missing diagnostic is
 *   visible and self-correcting, a leak is silent, and indicator details are
 *   arbitrary app-supplied objects.
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
  /**
   * Validator for the details gate: `health.details: "when-authenticated"`
   * admits callers through this, falling back to the server's validator when
   * unset. It is not a wall. The health surface answers every probe without
   * a credential whatever this says, because an orchestrator's probe carries
   * none and a health endpoint that answers it 401 is a health endpoint that
   * restarts the pod. `health.details: "always"` is the way to serve
   * details to every caller.
   *
   * The management tiers under `/ops` identify their caller through this
   * same validator, and each tier's own {@link OpsTier} value decides what
   * that identity must carry. `false` follows the server plugin's meaning
   * unchanged: no validator is effective for this mount, so the details
   * gate closes and a scope-gated tier has nothing to check against, which
   * fails the boot rather than admitting everyone.
   */
  auth?: HttpAuth | false;
  /** Health endpoint configuration. */
  health?: OpsHealthOptions;
  /**
   * The management API's exposure, one field per tier. Every tier is
   * disabled unless named here, so an app that configures nothing serves
   * health and answers 404 on every `/ops` path.
   *
   * See {@link OpsTier} for what each value means. A scope string needs a
   * validator in scope to check it against, so one written with no `auth`
   * on this mount and none on its server fails the boot rather than
   * admitting everyone.
   */
  tiers?: OpsTiers;
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

/**
 * One management tier's admission rule.
 *
 * - `false` (and unset): the tier is disabled and its paths answer 404.
 * - `true`: the tier is open and needs no credential of its own.
 * - a scope string: the caller's principal must carry that scope.
 *
 * The mount's `auth` (its own, or the named server's, per the server
 * plugin's inheritance) decides WHO the caller is; this value decides what
 * that identity must carry. The two are deliberately separate: the same
 * validator serves every tier, and only the requirement differs.
 *
 * Disabled answers 404 rather than 403 so an unconfigured instance
 * discloses nothing about what it could expose, and so the rule is the one
 * an ingress proxy would enforce in front of it.
 */
export type OpsTier = boolean | string;

/**
 * The management tiers, individually exposed. Unset is `false`, so an app
 * that configures nothing answers 404 on every management path.
 *
 * `operations` (taking a route offline, resetting a breaker) is named in
 * the design and deliberately not delivered yet; it slots in here without
 * reshaping anything.
 */
export interface OpsTiers {
  /** `GET /ops/routes` and `GET /ops/routes/{id}`. */
  introspection?: OpsTier;
  /** `POST /ops/routes/{id}/exchanges`. */
  dispatch?: OpsTier;
}

/** Documented default scope name for the introspection tier. */
export const OPS_SCOPE_INTROSPECTION = "ops:introspection";
/** Documented default scope name for the dispatch tier. */
export const OPS_SCOPE_DISPATCH = "ops:dispatch";

/**
 * A collection response. Never a bare array, from the first release: a
 * present `nextCursor` means there is more, and a correct client follows
 * it even against a collection that does not produce one today.
 */
export interface OpsPage<T> {
  items: T[];
  /** Opaque keyset cursor. Absent on the last page. */
  nextCursor?: string;
}

/**
 * JSON Schema renderings of a route's declared schemas, when the schema
 * library exposes the non-standard `~standard.jsonSchema` extension. A
 * library without it yields nothing here; the live schema is what
 * validation runs against either way, so nothing depends on these.
 */
export interface OpsRouteSchemas {
  body?: unknown;
  headers?: unknown;
}

/**
 * A route as the management API presents it.
 *
 * `dispatchable` is observed rather than inferred: a `direct()` ingress
 * registers the route in the capability registry when it subscribes, and
 * that registration is the door `POST .../exchanges` goes through. A cron-,
 * mail- or http-sourced route has no such door and says so here rather than
 * failing at dispatch time.
 */
export interface OpsRouteSummary {
  id: string;
  dispatchable: boolean;
  /** Source kinds, in declaration order (`direct`, `cron`, `mail`, ...). */
  sources: string[];
  /** The route declares a route-entry `.authorize()`. */
  requiresPrincipal: boolean;
  title?: string;
  description?: string;
  tags?: string[];
}

/** One route in full. Adds the schema renderings to the summary. */
export interface OpsRouteDetail extends OpsRouteSummary {
  input?: OpsRouteSchemas;
  output?: OpsRouteSchemas;
}

/** Documented filters on `GET /ops/routes`. */
export interface OpsRouteFilter {
  /** Only routes that do (or do not) have a dispatch door. */
  dispatchable?: boolean;
  /** Exact route id match, not a prefix. */
  id?: string;
  /** Routes carrying a source of this kind. */
  source?: string;
}

/** A page request against the route collection. */
export interface OpsRouteQuery extends OpsRouteFilter {
  limit?: number;
  after?: string;
}

/**
 * What a dispatch produced.
 *
 * A park is an outcome, not an error: a route that reaches a durable
 * `.suspend()` replies with the acknowledgment every other surface returns,
 * and the operator at the terminal is often exactly who the park waits for.
 * A drop is separate from a failure because they need different answers: a
 * drop means a filter said no, a failure means something broke.
 */
export type OpsDispatchOutcome =
  | { outcome: "completed"; body: unknown }
  | { outcome: "suspended"; suspension: Suspended }
  | { outcome: "dropped"; message: string };
