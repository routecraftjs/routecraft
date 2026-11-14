import {
  authorityOf,
  CONTINUATIONS,
  CraftClient,
  routeCanDefer,
  type CraftContext,
} from "@routecraft/routecraft";
import { AGENTS } from "../../src/agent/port.ts";
import type {
  AgentSessionRuntime,
  SessionHost,
} from "../../src/agent/session/runtime.ts";
import type { AgentHost, ToolHost } from "../../src/agent/tools/types.ts";

/**
 * The application's session runtime, for a test that drives a session
 * directly rather than through a dispatch.
 */
export function sessionsOf(ctx: CraftContext): AgentSessionRuntime {
  const registry = ctx.lookup(AGENTS);
  if (registry === undefined) {
    throw new Error(
      "sessionsOf: this test context has no agent plugin; build it with agent: {} or agentPlugin().",
    );
  }
  return registry.sessions();
}

/** A session host over a context, for a test that builds its own runtime. */
export function sessionHostOf(ctx: CraftContext): SessionHost {
  return {
    logger: ctx.logger,
    emit: (event, details) => ctx.emit(event, details),
    observe: (event, handler, options) => {
      ctx.on(event, handler, options);
    },
    deferrals: () => ctx.lookup(CONTINUATIONS),
    continuations: ctx.continuations,
    trackTask: (task, route) =>
      ctx.trackTask(task, route === undefined ? undefined : { route }),
    agent: (name) => ctx.lookup(AGENTS)?.agents.get(name),
    reidentify: () => ctx.lookup(AGENTS)?.reidentify,
  };
}

/**
 * A tool host over a context: the agent runtime's own when the context has
 * one, otherwise one built from the context so a resolver can be tested
 * without the plugin.
 */
export function toolHostOf(ctx: CraftContext): ToolHost {
  const registry = ctx.lookup(AGENTS);
  if (registry !== undefined) return registry.host.tools;
  return {
    capabilities: () => ctx.capabilities(),
    hasRoute: (routeId) => ctx.getRouteById(routeId) !== undefined,
    disabledReason: (routeId) =>
      ctx.getRouteById(routeId) === undefined || ctx.isRouteEnabled(routeId)
        ? undefined
        : (ctx.disabledRoutes().get(routeId) ??
          "disabled by its enabled() predicate"),
    canDefer: (routeId) => {
      const route = ctx.getRouteById(routeId);
      return route !== undefined && routeCanDefer(route.definition, ctx);
    },
    deliver: (endpoint, body, headers) =>
      new CraftClient(ctx).sendDirect(endpoint, body, headers),
    sessions: () => sessionsOf(ctx),
  };
}

/**
 * What an agent dispatch reads the application through, for a test that
 * calls a resolver or the tool bridge directly. A dispatch builds the same
 * shape from its exchange.
 */
export function agentHostOf(ctx: CraftContext): AgentHost {
  return {
    logger: ctx.logger,
    emit: (event, details) => ctx.emit(event, details),
    tools: toolHostOf(ctx),
    application: ctx.lookup(AGENTS) ?? ctx,
    lookup: (port) => ctx.lookup(port),
    get authority() {
      return authorityOf(ctx);
    },
    outboundTraceContext: ctx.outboundTraceContext,
  };
}
