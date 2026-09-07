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
  type CraftContext,
  type CraftPlugin,
  type Exchange,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { agent } from "../agent/agent.ts";
import { ADAPTER_AGENT_REGISTRY } from "../agent/store.ts";
import "../errors.ts";
import { AcpRuntime, ACP_ROUTE_PREFIX, type AcpPromptBody } from "./runtime.ts";
import { AcpServer, normalizeAcpPath } from "./server.ts";
import type { AcpPluginOptions } from "./types.ts";

/**
 * Serve the Agent Client Protocol over Streamable HTTP.
 *
 * ```ts
 * export default defineConfig({
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
export function acpPlugin(options: AcpPluginOptions = {}): CraftPlugin {
  // Validated at construction, so a bad path fails where it was written
  // rather than at the first request.
  if (options.path !== undefined) normalizeAcpPath(options.path);
  if (options.server !== undefined && options.server.length === 0) {
    throw new TypeError("acpPlugin: server name must not be empty");
  }

  let runtime: AcpRuntime | undefined;
  let server: AcpServer | undefined;

  return {
    async apply(context: CraftContext) {
      const agents = context.getStore(ADAPTER_AGENT_REGISTRY);
      if (agents === undefined || agents.size === 0) {
        throw rcError("RC5003", undefined, {
          message:
            "ACP serves the agents this context has registered, and none were registered when it applied. " +
            "Write the agents under `agent:` (or let `craft start` discover them), or list acpPlugin() after the agentPlugin() that registers them in `plugins`.",
        });
      }
      runtime = new AcpRuntime(context, options);
      runtime.subscribe();
      context.registerRoutes(...turnRoutes(runtime, [...agents.keys()]));
      server = new AcpServer(context, runtime, options);
      await server.prepare();
      context.logger.info(
        { path: options.path ?? "/acp", agents: agents.size },
        "ACP mount registered",
      );
    },
    async teardown() {
      runtime?.unsubscribe();
      await server?.stop();
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

/**
 * The body the mount sent.
 *
 * Read rather than validated: the route is `internal`, so the mount is the
 * only thing that can reach it, and a schema here would describe a
 * boundary that does not exist.
 */
function promptBodyOf(exchange: Exchange<unknown>): AcpPromptBody {
  return exchange.body as AcpPromptBody;
}
