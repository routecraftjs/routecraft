import {
  authorityOf,
  CONTINUATIONS,
  type CraftContext,
} from "@routecraft/routecraft";
import {
  agentHostFor,
  agentHosts,
  type AgentHost,
  type AgentRuntimeHost,
} from "../../src/agent/host.ts";
import { AGENTS } from "../../src/agent/port.ts";
import type {
  AgentSessionRuntime,
  SessionHost,
} from "../../src/agent/session/runtime.ts";
import type { ToolHost } from "../../src/agent/tools/types.ts";

/** The agent runtime's host in a test context, which must install the agent plugin. */
function runtimeOf(ctx: CraftContext): AgentRuntimeHost {
  const runtime = agentHosts.get(ctx.application);
  if (runtime === undefined) {
    throw new Error(
      "this test context has no agent plugin; build it with agent: {} or agentPlugin().",
    );
  }
  return runtime;
}

/**
 * The application's session runtime, for a test that drives a session
 * directly rather than through a dispatch.
 */
export function sessionsOf(ctx: CraftContext): AgentSessionRuntime {
  return runtimeOf(ctx).tools.sessions();
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

/** The tool host the agent runtime built for a test context. */
export function toolHostOf(ctx: CraftContext): ToolHost {
  return runtimeOf(ctx).tools;
}

/**
 * What an agent dispatch reads the application through, for a test that
 * calls a resolver or the tool bridge directly: the host a dispatch in this
 * context would build.
 */
export function agentHostOf(ctx: CraftContext): AgentHost {
  return agentHostFor(
    runtimeOf(ctx),
    ctx,
    authorityOf(ctx),
    ctx.outboundTraceContext,
  );
}
