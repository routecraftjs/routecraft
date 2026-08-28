/**
 * Ops plugin: the operational surface, with health as its first capability.
 *
 * It folds framework lifecycle events into a per-context {@link HealthState}
 * and serves the result over HTTP. The judgement lives in `state.ts` and the
 * response contract in `report.ts`; this file is the wiring.
 *
 * The surface is a mount on a named server rather than a listener of its own,
 * so an internal-only ops port is a second entry in `defineConfig({ servers })`
 * that this mount points at, and the socket's lifecycle belongs to the server
 * plugin.
 */

import type { CraftContext, CraftPlugin } from "../../context";
import { parseDuration } from "../../shared/duration.ts";
import { rcError } from "../../error";
import { requireWebIngress } from "../server/registry";
import type { PathClaim } from "../server/types";
import {
  bindIndicator,
  isIndicator,
  unbindIndicator,
  unboundIndicators,
} from "./indicator";
import { createManagementApi } from "./management";
import { createManagementHandler } from "./mount";
import { createHealthHandler } from "./report";
import { HealthState } from "./state";
import { OPS_HEALTH_STATE } from "./store";
import { enforcesWall } from "./tier";
import type { Indicator, OpsPluginOptions, OpsTiers } from "./types";

/**
 * Everything the mount answers. Claimed exhaustively so the server's
 * bind-time validation catches a collision with another surface rather than
 * letting dispatch order decide who owns `/health`.
 *
 * `/ops` carries the management API. The prefix is claimed whole even when
 * every tier is disabled, so a disabled tier answers this mount's 404
 * rather than falling through to whatever else a shared listener carries.
 */
const CLAIMS: readonly PathClaim[] = [
  { kind: "prefix", path: "/health" },
  { kind: "prefix", path: "/ops" },
];

/** Per-context state. One plugin instance may serve several contexts. */
interface Runtime {
  state: HealthState;
  unsubscribes: (() => void)[];
  /** The mount's effective validator exists (its own auth, or the server's). */
  authConfigured: boolean;
  unmount?: () => void;
}

/**
 * The operational surface for a routecraft app.
 *
 * Materialised by the config applier, so apps normally configure it with
 * `defineConfig({ ops: {} })` rather than pushing it onto `config.plugins`.
 * The function is exported for advanced wiring.
 *
 * What it reports needs no application code: route lifecycle, circuit-breaker
 * position and the context's own serving state are all derived from events the
 * framework already emits. Indicators are the one thing an app adds by hand,
 * for dependencies the framework cannot see.
 *
 * Lifecycle:
 * - `apply(ctx)`: build the ledger, bind indicators, subscribe to lifecycle
 *   events, and register the mount. Nothing is listening yet, so a
 *   misconfiguration fails the build rather than a live surface.
 * - `start(ctx)`: check that every route-bound indicator names a real route.
 *   The server binds its listener in its own `start()`, after routes are up,
 *   so a probe arriving before that gets connection refused, which every
 *   orchestrator reads as not-ready.
 * - `teardown(ctx)`: unmount, unsubscribe, and release the indicator bindings.
 *
 * The health surface never walls, whatever `auth` says: the ingress never
 * authenticates on its own, and this surface calls `authenticate()` only to
 * decide whether to serve `details`. A probe carrying no credential still
 * gets every status, which is the only way an orchestrator can use it, while
 * an operator holding a token the effective validator (the mount's own
 * `auth`, else the server's) admits also gets the diagnostics.
 */
export function opsPlugin(options: OpsPluginOptions = {}): CraftPlugin {
  validate(options);

  const serverName = options.server ?? "default";
  const detailsExposure = options.health?.details ?? "when-authenticated";
  const detailsExplicit = options.health?.details !== undefined;
  const mountAuthOption = options.auth;
  const tiers: OpsTiers = options.tiers ?? {};
  const indicators: readonly Indicator[] = options.indicators ?? [];

  const runtimes = new WeakMap<CraftContext, Runtime>();

  return {
    name: "ops",

    apply(ctx: CraftContext) {
      // Everything below is resolved and validated before anything with a
      // side effect happens. The boot unwind is not guaranteed to reach this
      // plugin's teardown, so a binding or subscription installed before a
      // later throw would outlive the dead context.
      const ingress = requireWebIngress(ctx, serverName);
      const mountAuth = ingress.resolveMountAuth(mountAuthOption);

      // Explicit intent with nothing to gate on is refused; only the
      // unwritten default may collapse (to `never`, in the handler).
      if (
        detailsExplicit &&
        detailsExposure === "when-authenticated" &&
        !mountAuth.configured
      ) {
        throw rcError("RC5053", undefined, {
          message: `ops.health.details is "when-authenticated" but no validator is in scope: the ops mount declares no auth and servers.${serverName} has none. Set ops.auth (or servers.${serverName}.auth) to gate details, "always" to serve them to every caller, or "never" to withhold them.`,
        });
      }

      // Gated on `walled`, not `configured`: a tier scope check refuses the
      // request, so it is a wall, and `auth: false` says this mount declares
      // none while keeping the inherited validator reachable for pulls.
      for (const [name, value] of Object.entries(tiers)) {
        if (typeof value !== "string" || mountAuth.walled) continue;
        throw rcError("RC5053", undefined, {
          message: `ops.tiers.${name} requires the scope "${value}" but no validator is in scope: the ops mount ${mountAuthOption === false ? "opted out of auth with `auth: false`" : "declares no auth"} and servers.${serverName} has none. Set ops.auth (or servers.${serverName}.auth) so a credential can be verified, or set the tier to true to expose it without one.`,
        });
      }

      // Refused here rather than at mountHttp: by the time the mount is
      // registered this apply() has already replaced the published ledger and
      // rebound every indicator to it, so a second instance would leave the
      // already-mounted handler reporting from a ledger nothing writes to.
      if (ingress.hasMount("ops")) {
        throw rcError("RC5053", undefined, {
          message: `servers.${serverName} already carries an ops mount. One ops surface per server: configure it once through defineConfig({ ops }), or point the second at another named server.`,
        });
      }

      const state = new HealthState({
        onChange: (change) => {
          ctx.emit("plugin:ops:health:changed", change);
        },
      });
      const runtime: Runtime = {
        state,
        unsubscribes: [],
        authConfigured: mountAuth.configured,
      };
      runtimes.set(ctx, runtime);
      ctx.setStore(OPS_HEALTH_STATE, state);

      const names = new Set<string>();
      for (const indicator of indicators) {
        if (!isIndicator(indicator)) {
          throw rcError("RC5053", undefined, {
            message: `ops.indicators contains a value defineIndicator() did not produce. Declare indicators with defineIndicator({ name }); an object of the same shape has no ledger to report into.`,
          });
        }
        if (names.has(indicator.name)) {
          throw rcError("RC5053", undefined, {
            message: `Duplicate indicator name "${indicator.name}" in ops.indicators. Indicator names are the keys of the health report, so they must be unique.`,
          });
        }
        names.add(indicator.name);
      }

      for (const indicator of indicators) {
        const { maxAge, domain } = indicator.definition;
        const maxAgeMs =
          maxAge === undefined ? undefined : parseDuration(maxAge, "maxAge");
        state.registerIndicator(indicator.name, {
          ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
          ...(domain !== undefined ? { domain } : {}),
        });
        bindIndicator(indicator, ctx, state);
      }

      // Indicators bound to a route, keyed by route id, so one subscription
      // serves however many indicators name the same probe.
      const boundIndicators = new Map<string, string[]>();
      for (const indicator of indicators) {
        const boundRoute = indicator.definition.route;
        if (boundRoute === undefined) continue;
        const names = boundIndicators.get(boundRoute) ?? [];
        names.push(indicator.name);
        boundIndicators.set(boundRoute, names);
      }
      const hasBoundIndicators = boundIndicators.size > 0;

      const { unsubscribes } = runtime;
      unsubscribes.push(
        // `context:started` is deliberately not subscribed. It fires before
        // routes are started, so readiness taken from it would answer 200 to
        // an orchestrator while a source is still coming up. The context is
        // marked started in this plugin's own start() hook instead, which the
        // framework runs after route readiness settles.
        ctx.on("context:stopping", () => state.contextStopping()),
        ctx.on("route:started", ({ details }) => {
          state.routeStarted(details.routeId);
        }),
        ctx.on("route:stopped", ({ details }) => {
          state.routeStopped(details.routeId);
        }),
        // Disabled is reported distinctly from failed, WITH its reason, and
        // never degrades the aggregate: an operator reading /ops sees
        // "mail-inbound: disabled (MAIL_USER, MAIL_APP_PASSWORD unset)" and
        // knows immediately that nothing is broken.
        ctx.on("route:enablement:changed", ({ details }) => {
          if (details.enabled) {
            state.clearRouteDisabled(details.routeId);
          } else {
            state.setRouteDisabled(
              details.routeId,
              details.reason ?? "disabled by its enabled() predicate",
            );
          }
        }),
        // The only route-liveness signal. `context:error` is deliberately not
        // subscribed: it fires for every unhandled exchange error and for any
        // throwing event handler, so reading it as a dead source would make
        // one refused caller report the route down.
        ctx.on("route:source:failed", ({ details }) => {
          state.sourceDied(details.routeId);
        }),
        ctx.on("route:exchange:completed", ({ details }) => {
          state.exchangeCompleted(details.routeId);
          if (hasBoundIndicators) {
            for (const name of boundIndicators.get(details.routeId) ?? []) {
              state.reportIndicator(name, { status: "up" });
            }
          }
        }),
        // `route:exchange:dropped` is deliberately not subscribed. A drop is
        // the third terminal state and suppresses `completed`, but it is not
        // evidence either way: the exchange may have been filtered out before
        // the dependency was ever reached. Reporting a verdict from it would
        // be inventing one, so a bound indicator on a route that only drops
        // goes stale, which is the truthful answer.
        ctx.on("route:exchange:failed", ({ details }) => {
          state.exchangeFailed(details.routeId);
          if (hasBoundIndicators) {
            for (const name of boundIndicators.get(details.routeId) ?? []) {
              state.reportIndicator(name, { status: "down" });
            }
          }
        }),
        // A breaker is the one thing that turns repeated failure into a health
        // signal, because it is the one thing that actually stops the route
        // serving. Both scopes count: a step-scope breaker still means part of
        // this route is refusing work.
        ctx.on("route:circuitBreaker:opened", ({ details }) => {
          state.circuitOpened(details.routeId, details.stepLabel, "open");
        }),
        ctx.on("route:circuitBreaker:halfOpen", ({ details }) => {
          state.circuitOpened(details.routeId, details.stepLabel, "half-open");
        }),
        ctx.on("route:circuitBreaker:closed", ({ details }) => {
          state.circuitClosed(details.routeId, details.stepLabel);
        }),
      );

      const health = createHealthHandler({
        state,
        details: detailsExposure,
        uptime: () => process.uptime(),
      });
      const management = createManagementHandler({
        api: createManagementApi(ctx),
        tiers,
        onRefused: ({ reason, scheme }) => {
          ctx.emit("auth:rejected", { reason, scheme, source: "ops" });
        },
      });

      // One mount, two surfaces with opposite postures. Management is
      // offered the request first and answers `undefined` for anything
      // outside `/ops`, so neither surface has to know the other's routing
      // table and `/health` keeps answering exactly as it did.
      const handler = async (
        req: Request,
        mountContext: Parameters<typeof health>[1],
      ): Promise<Response> =>
        (await management(req, mountContext)) ?? health(req, mountContext);

      // The scopes the RFC 9728 document may advertise: exactly the tier
      // gates an operator configured, deduplicated in configuration order.
      // Boolean tiers contribute nothing; there is no scope to name.
      const tierScopes = [
        ...new Set(
          Object.values(tiers).filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      ];
      runtime.unmount = ingress.mountHttp({
        id: "ops",
        // The health paths never wall, so the flag answers for the mount as
        // a whole only when a management tier actually gates on a scope.
        // Without that, the registry's inherited-authentication log would
        // claim a gate this mount never runs.
        enforcesWall: enforcesWall(tiers),
        ...(mountAuthOption !== undefined ? { auth: mountAuthOption } : {}),
        ...(tierScopes.length > 0
          ? { resourceMetadata: { scopesSupported: tierScopes } }
          : {}),
        claims: () => CLAIMS,
        handler,
      });
    },

    start(ctx: CraftContext) {
      const runtime = runtimes.get(ctx);
      if (!runtime) return;

      // An indicator naming a route that does not exist is a typo that would
      // otherwise present as a dependency stuck reporting nothing. Routes are
      // registered by the time start() runs, so this is the first point the
      // check can be made.
      const known = new Set(
        ctx.getRoutes().map((route) => route.definition.id),
      );
      for (const indicator of indicators) {
        const boundRoute = indicator.definition.route;
        if (boundRoute !== undefined && !known.has(boundRoute)) {
          throw rcError("RC5053", undefined, {
            message: `Indicator "${indicator.name}" is bound to route "${boundRoute}", which no route declares. Known routes: ${[...known].sort().join(", ") || "(none)"}.`,
          });
        }
      }

      // Every declared route is listed, whether or not it signalled. Route
      // readiness is bounded by a timeout, so a source that never signals
      // would otherwise be missing from the report rather than shown as
      // unproven. Routes that did signal already have their real state.
      for (const route of ctx.getRoutes()) {
        runtime.state.declareRoute(route.definition.id);
      }

      // Routes disabled during the boot: their `route:enablement:changed`
      // fired while the context was starting, which is before this plugin's
      // start() hook runs, so the subscription above missed it. Replayed
      // from the context's own record rather than by re-evaluating the
      // predicates, which would run a user's credential check a second time
      // for a state the context already holds.
      for (const [routeId, reason] of ctx.disabledRoutes()) {
        runtime.state.setRouteDisabled(routeId, reason);
      }

      // Reaching this with the gate mode and no validator means the
      // unwritten default collapsed; the explicit case was refused at apply.
      if (detailsExposure === "when-authenticated" && !runtime.authConfigured) {
        ctx.logger.warn(
          { server: serverName, plugin: "ops" },
          `ops.health serves statuses only: no validator is in scope, so the default "when-authenticated" gate withholds per-component details from every caller. Set ops.auth (or servers.${serverName}.auth) to gate them, or health.details: "always" to serve them to everyone.`,
        );
      }

      const unbound = unboundIndicators();
      if (unbound.length > 0) {
        ctx.logger.warn(
          { indicators: unbound, plugin: "ops" },
          `Indicators declared but not registered: ${unbound.join(", ")}. A push through an unregistered handle is inert, so these dependencies would never appear in the health report. Add them to ops.indicators.`,
        );
      }

      // Routes have started by the time a plugin's start() hook runs, so this
      // is the first moment the context can honestly claim to be serving.
      runtime.state.contextStarted();
    },

    teardown(ctx: CraftContext) {
      const runtime = runtimes.get(ctx);
      if (!runtime) return;

      // teardown must tolerate its own start() never having run: the unwind
      // after a failed boot tears down every applied plugin. Unwinding in
      // `finally` keeps the subscriptions and bindings from leaking if the
      // unmount throws.
      try {
        runtime.unmount?.();
      } finally {
        // The terminal state is set here rather than from `context:stopped`,
        // which the framework emits after every teardown has run and so after
        // these subscriptions are gone. Without it a store reader would see a
        // context draining forever.
        runtime.state.contextStopped();
        for (const unsubscribe of runtime.unsubscribes) unsubscribe();
        for (const indicator of indicators) unbindIndicator(indicator, ctx);
        runtimes.delete(ctx);
      }
    },
  };
}

function validate(options: OpsPluginOptions): void {
  for (const [name, value] of Object.entries(options.tiers ?? {})) {
    if (typeof value === "boolean" || value === undefined) continue;
    if (typeof value !== "string") {
      throw rcError("RC5053", undefined, {
        message: `ops.tiers.${name} must be false, true, or a scope string; received ${JSON.stringify(value)}.`,
      });
    }
    if (value.trim() === "") {
      throw rcError("RC5053", undefined, {
        message: `ops.tiers.${name} is an empty scope string, which no principal can carry and so refuses every caller. Use false to disable the tier, true to expose it without a credential, or a real scope name.`,
      });
    }
  }
  const exposure = options.health?.details;
  if (
    exposure !== undefined &&
    exposure !== "always" &&
    exposure !== "when-authenticated" &&
    exposure !== "never"
  ) {
    throw rcError("RC5053", undefined, {
      message: `opsPlugin: invalid health.details ${JSON.stringify(exposure)}. Use "always", "when-authenticated", or "never".`,
    });
  }
}
