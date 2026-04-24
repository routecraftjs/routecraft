import {
  rcError,
  type CraftContext,
  type CraftPlugin,
} from "@routecraft/routecraft";
import { ADAPTER_AGENT_REGISTRY } from "./store.ts";
import type { AgentRegisteredOptions, AgentRegistration } from "./types.ts";
import { AGENT_REGISTRATION_BRAND } from "./types.ts";

export interface AgentPluginOptions {
  /**
   * Agents to register for by-name lookup via `agent("id")`. Use
   * `defineAgent({ id, ... })` to construct each entry. Duplicate ids throw
   * at context init.
   */
  agents?: AgentRegistration[];
}

function isAgentRegistration(value: unknown): value is AgentRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [k: symbol]: unknown })[AGENT_REGISTRATION_BRAND] === true
  );
}

/**
 * Agent plugin: registers agents in the context store so routes can
 * reference them by name via `agent("id")`. Throws on duplicate id at
 * context init.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { agentPlugin, defineAgent } from "@routecraft/ai";
 *
 * agentPlugin({
 *   agents: [
 *     defineAgent({
 *       id: "summariser",
 *       description: "Summarises documents into bullet points",
 *       model: "anthropic:claude-opus-4-7",
 *       system: "You are a summariser. Be concise.",
 *     }),
 *   ],
 * });
 * ```
 */
export function agentPlugin(options: AgentPluginOptions = {}): CraftPlugin {
  const agents = options.agents ?? [];
  return {
    apply(ctx: CraftContext) {
      // Merge into an existing registry when present so multiple
      // `agentPlugin({...})` entries compose instead of overwriting.
      const existing = ctx.getStore(
        ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as Map<string, AgentRegisteredOptions> | undefined;
      const map = existing ?? new Map<string, AgentRegisteredOptions>();
      for (const entry of agents) {
        if (!isAgentRegistration(entry)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: every entry in "agents" must be produced by defineAgent(...).`,
          });
        }
        const { id } = entry.options;
        if (map.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate agent id "${id}". Each agent id must be unique within a context.`,
          });
        }
        map.set(id, entry.options);
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
