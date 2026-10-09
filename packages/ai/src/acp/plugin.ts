/**
 * `acpPlugin()`: serve the Agent Client Protocol, so a person can talk to
 * this instance's agents from their editor.
 *
 * Nothing ships switched off. Installing the plugin serves the protocol on
 * the same server and behind the same wall as everything else the instance
 * exposes, and the framework's own name reaches the editor unless the app
 * replaces it.
 */

import {
  craft,
  direct,
  rcError,
  WEB_INGRESS,
  type Plugin,
  type PluginContext,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { agent } from "../agent/agent.ts";
import { agentRuntimePlugin } from "../agent/plugin.ts";
import { AGENTS } from "../agent/port.ts";
import { SURFACES, surfacesPlugin } from "../surface/index.ts";
import "../errors.ts";
import { AcpRuntime, ACP_ROUTE_PREFIX, promptBodyOf } from "./runtime.ts";
import { AcpServer, normalizeAcpPath } from "./server.ts";
import type { AcpPluginOptions } from "./types.ts";

/**
 * Serve the Agent Client Protocol over Streamable HTTP.
 *
 * ```ts
 * export const craftConfig = defineConfig({
 *   servers: { default: { port: 8080 } },
 *   acp: { auth },
 * });
 * ```
 *
 * The `acp` key is the first-party form and applies after `agent` in any
 * key order. As a plugin in `plugins`, **order matters, and it is
 * checked.** The plugin builds one route per agent when it applies, so it
 * has to apply after the `agentPlugin()` that registers them. A context
 * whose registry is empty at that moment fails the build with a message
 * saying so, rather than serving a protocol with nothing behind it.
 *
 * Every agent the context holds is advertised to every credential holder.
 * There is no per-agent visibility rule: agents are not what carries the
 * security here, hands are, and each one authorizes the caller on every
 * call under the principal of the person who typed the prompt.
 */
export function acpPlugin(options: AcpPluginOptions = {}): Plugin {
  // Validated at construction, so a bad path fails where it was written
  // rather than at the first request.
  if (options.path !== undefined) normalizeAcpPath(options.path);
  if (options.server !== undefined && options.server.length === 0) {
    throw new TypeError("acpPlugin: server name must not be empty");
  }

  // Keyed by the plugin context: one descriptor can serve two applications
  // in one process (a config reused across tests).
  const mounts = new WeakMap<
    PluginContext,
    { runtime: AcpRuntime; server?: AcpServer }
  >();

  return {
    id: "routecraft.ai.acp",
    requires: [AGENTS, SURFACES],
    // Brings the agent runtime so an application with no agents gets the
    // refusal below, which names the fix, rather than a bare missing port.
    installs: [surfacesPlugin(), agentRuntimePlugin()],
    optional: [WEB_INGRESS],
    async bind(c: PluginContext) {
      const registry = c.require(AGENTS);
      const agents = registry.agents;
      if (agents.size === 0) {
        throw rcError("RC5003", undefined, {
          message:
            "ACP serves the agents this context registers, and it registers none. " +
            "Write the agents under `agent:`, list an agentPlugin() in `plugins`, or let `craft start` discover them.",
        });
      }
      const runtime = new AcpRuntime(c, registry, c.require(SURFACES), options);
      const mount: { runtime: AcpRuntime; server?: AcpServer } = { runtime };
      mounts.set(c, mount);
      runtime.subscribe();
      c.routes.register(...turnRoutes(runtime, [...agents.keys()]));
      const server = new AcpServer(c, runtime, options);
      mount.server = server;
      await server.prepare();
      c.logger.info(
        { path: options.path ?? "/acp", agents: agents.size },
        "ACP mount registered",
      );
    },
    async stop(c: PluginContext) {
      const mount = mounts.get(c);
      mounts.delete(c);
      mount?.runtime.unsubscribe();
      await mount?.server?.stop();
    },
  };
}

/**
 * One `direct()` route per agent, which is what a prompt is a send into.
 *
 * Building routes rather than reaching past the runtime is what makes a
 * turn an ordinary exchange: telemetry, route events, error handling and
 * the principal all work exactly as they do everywhere else, and no
 * ACP-shaped special case reaches the engine.
 *
 * The routes are internal, so they are not dispatchable through the
 * management API and not resolvable as an agent tool. A prompt reaches
 * them through the mount, which is the only door they have.
 */
function turnRoutes(
  runtime: AcpRuntime,
  names: readonly string[],
): RouteDefinition[] {
  return names.flatMap((name) =>
    craft()
      .id(`${ACP_ROUTE_PREFIX}${name}`)
      .description(`Editor turns for the "${name}" agent`)
      .from(direct({ internal: true }))
      .to(
        agent(name, {
          session: (exchange) => promptBodyOf(exchange).session,
          // Resolved per exchange: one route serves every connected
          // editor at once, so a listener fixed when the route was built
          // would stream one person's turn into another person's window.
          onDeltaFor: (exchange) => runtime.sinkFor(exchange),
          // The editor's request stays open until its message is
          // answered; an acknowledgement would show it finished with
          // nothing under it.
          hold: true,
        }),
      )
      .build(),
  );
}
