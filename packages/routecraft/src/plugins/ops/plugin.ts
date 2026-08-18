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
import { rcError } from "../../error";
import { requireWebIngress } from "../server/registry";
import type { PathClaim } from "../server/types";
import { bindIndicator, isIndicator, unbindIndicator } from "./indicator";
import { createHealthHandler } from "./report";
import { HealthState } from "./state";
import { OPS_HEALTH_STATE } from "./store";
import type { Indicator, OpsPluginOptions } from "./types";

/**
 * Everything the mount answers. Claimed exhaustively so the server's
 * bind-time validation catches a collision with another surface rather than
 * letting dispatch order decide who owns `/health`.
 *
 * `/ops` is the action namespace (taking a route offline, resetting a
 * breaker). It is claimed now and answers 404 until those ship, so the paths
 * cannot be squatted by another mount in the meantime.
 */
const CLAIMS: readonly PathClaim[] = [
  { kind: "prefix", path: "/health" },
  { kind: "prefix", path: "/ops" },
];

/** Per-context state. One plugin instance may serve several contexts. */
interface Runtime {
  state: HealthState;
  unsubscribes: (() => void)[];
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
 */
export function opsPlugin(options: OpsPluginOptions = {}): CraftPlugin {
  validate(options);

  const serverName = options.server ?? "default";
  const detailsExposure = options.health?.details ?? "when-authenticated";
  const indicators: readonly Indicator[] = options.indicators ?? [];

  const runtimes = new WeakMap<CraftContext, Runtime>();

  return {
    name: "ops",

    apply(ctx: CraftContext) {
      // Resolved first: a server name no config declares must fail before the
      // ledger is published, the indicators are bound, and the subscriptions
      // are installed. The boot unwind is not guaranteed to reach this
      // plugin's own teardown, so bindings installed before the throw would
      // outlive the dead context in the module-scope binder map.
      const ingress = requireWebIngress(ctx, serverName);

      const state = new HealthState({
        onChange: (change) => {
          ctx.emit("plugin:ops:health:changed", change);
        },
      });
      const runtime: Runtime = { state, unsubscribes: [] };
      runtimes.set(ctx, runtime);
      ctx.setStore(OPS_HEALTH_STATE, state);

      // Validated in full before anything is bound: a throw partway through
      // would otherwise leave earlier handles bound to a context that never
      // starts, and the boot unwind is not guaranteed to reach this plugin's
      // teardown.
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
        const { maxAgeMs, domain } = indicator.definition;
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
        ctx.on("context:stopped", () => state.contextStopped()),
        ctx.on("route:started", ({ details }) => {
          state.routeStarted(details.routeId);
        }),
        ctx.on("route:stopped", ({ details }) => {
          state.routeStopped(details.routeId);
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

      const handler = createHealthHandler({
        state,
        details: detailsExposure,
        serverAuthConfigured: ingress.serverAuthConfigured,
        uptime: () => process.uptime(),
      });

      runtime.unmount = ingress.mountHttp({
        id: "ops",
        claims: () => CLAIMS,
        // `auth` is deliberately left unset so the mount inherits the server's
        // validator. Inheriting does not gate anything here: the ingress never
        // authenticates on its own, the mount does, and this handler only ever
        // calls `authenticate()` to decide whether to serve `details`. The
        // surface therefore stays open to a probe with no credential, which is
        // the only way an orchestrator can use it, while an operator holding a
        // token still gets the diagnostics.
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
        for (const unsubscribe of runtime.unsubscribes) unsubscribe();
        for (const indicator of indicators) unbindIndicator(indicator, ctx);
        runtimes.delete(ctx);
      }
    },
  };
}

function validate(options: OpsPluginOptions): void {
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
