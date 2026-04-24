import {
  rcError,
  type CraftContext,
  type CraftPlugin,
} from "@routecraft/routecraft";
import { validateAgentOptions } from "./agent.ts";
import { ADAPTER_AGENT_REGISTRY } from "./store.ts";
import type { AgentRegisteredOptions } from "./types.ts";

export interface AgentPluginOptions {
  /**
   * Agents available for by-name lookup via `agent("id")`. Keyed by the
   * agent id; each entry provides the agent's description, model, system,
   * and optional user-prompt override. Duplicate ids across multiple
   * `agentPlugin` installs throw at context init.
   */
  agents?: Record<string, AgentRegisteredOptions>;
}

function validateRegisteredAgent(
  id: string,
  options: AgentRegisteredOptions,
): void {
  if (
    typeof options.description !== "string" ||
    options.description.trim() === ""
  ) {
    throw rcError("RC5003", undefined, {
      message:
        `agentPlugin: agent "${id}" is missing a non-empty "description". ` +
        `Registered agents carry their own description because they are not ` +
        `backed by a route.`,
    });
  }
  validateAgentOptions(options);
}

/**
 * Agent plugin: registers agents in the context store so routes can
 * reference them by name via `agent("id")`. Throws on duplicate id at
 * context init. Multiple `agentPlugin` instances compose: the second
 * install merges into the existing registry and still rejects duplicates.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { agentPlugin } from "@routecraft/ai";
 *
 * agentPlugin({
 *   agents: {
 *     summariser: {
 *       description: "Summarises documents into bullet points",
 *       model: "anthropic:claude-opus-4-7",
 *       system: "You are a summariser. Be concise.",
 *     },
 *   },
 * });
 * ```
 */
export function agentPlugin(options: AgentPluginOptions = {}): CraftPlugin {
  const agents = options.agents ?? {};
  return {
    apply(ctx: CraftContext) {
      // Merge into an existing registry when present so multiple
      // `agentPlugin({...})` entries compose instead of overwriting.
      const existing = ctx.getStore(
        ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as Map<string, AgentRegisteredOptions> | undefined;
      const map = existing ?? new Map<string, AgentRegisteredOptions>();
      for (const [id, entry] of Object.entries(agents)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent id must be a non-empty string.`,
          });
        }
        validateRegisteredAgent(id, entry);
        if (map.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate agent id "${id}". Each agent id must be unique within a context.`,
          });
        }
        map.set(id, entry);
      }
      if (!existing) {
        ctx.setStore(
          ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
          map,
        );
      }
    },
  };
}
