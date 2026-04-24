import {
  rcError,
  type CraftContext,
  type CraftPlugin,
} from "@routecraft/routecraft";
import { validateAgentOptions } from "./agent.ts";
import { ADAPTER_AGENT_REGISTRY } from "./store.ts";
import { validateFnOptions } from "../fn/fn.ts";
import { ADAPTER_FN_REGISTRY } from "../fn/store.ts";
import type { FnOptions } from "../fn/types.ts";
import type { AgentRegisteredOptions } from "./types.ts";

export interface AgentPluginOptions {
  /**
   * Agents available for by-name lookup via `agent("id")`. Keyed by the
   * agent id; each entry provides the agent's description, model, system,
   * and optional user-prompt override. Duplicate ids across multiple
   * `agentPlugin` installs throw at context init.
   */
  agents?: Record<string, AgentRegisteredOptions>;

  /**
   * Ad-hoc in-process functions available for agents (via `tools: [...]`
   * in follow-up stories) and for standalone invocation via
   * `invokeFn(context, id, input)`. Keyed by the fn id; each entry
   * provides description, Standard Schema, and handler. Duplicate ids
   * across multiple `agentPlugin` installs throw at context init.
   */
  functions?: Record<string, FnOptions>;
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
 * Agent plugin: registers agents and functions in the context store so
 * routes can reference them by name via `agent("id")` and fns are
 * available to tool-using agents (and to `invokeFn(context, id, input)`
 * for standalone calls). Throws on duplicate id (within agents, within
 * fns, or across multiple plugin installs) at context init.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { agentPlugin } from "@routecraft/ai";
 * import { z } from "zod";
 *
 * agentPlugin({
 *   agents: {
 *     summariser: {
 *       description: "Summarises documents into bullet points",
 *       model: "anthropic:claude-opus-4-7",
 *       system: "You are a summariser. Be concise.",
 *     },
 *   },
 *   functions: {
 *     currentTime: {
 *       description: "Current UTC timestamp in ISO 8601",
 *       schema: z.object({}),
 *       handler: async () => new Date().toISOString(),
 *     },
 *   },
 * });
 * ```
 */
export function agentPlugin(options: AgentPluginOptions = {}): CraftPlugin {
  const agents = options.agents ?? {};
  const functions = options.functions ?? {};
  return {
    apply(ctx: CraftContext) {
      // Merge into an existing registry when present so multiple
      // `agentPlugin({...})` entries compose instead of overwriting.
      const existingAgents = ctx.getStore(
        ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as Map<string, AgentRegisteredOptions> | undefined;
      const agentMap =
        existingAgents ?? new Map<string, AgentRegisteredOptions>();
      for (const [id, entry] of Object.entries(agents)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent id must be a non-empty string.`,
          });
        }
        validateRegisteredAgent(id, entry);
        if (agentMap.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate agent id "${id}". Each agent id must be unique within a context.`,
          });
        }
        agentMap.set(id, entry);
      }
      if (!existingAgents) {
        ctx.setStore(
          ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
          agentMap,
        );
      }

      const existingFns = ctx.getStore(
        ADAPTER_FN_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as Map<string, FnOptions> | undefined;
      const fnMap = existingFns ?? new Map<string, FnOptions>();
      for (const [id, entry] of Object.entries(functions)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: fn id must be a non-empty string.`,
          });
        }
        validateFnOptions(id, entry);
        if (fnMap.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate fn id "${id}". Each fn id must be unique within a context.`,
          });
        }
        fnMap.set(id, entry);
      }
      if (!existingFns) {
        ctx.setStore(
          ADAPTER_FN_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
          fnMap,
        );
      }
    },
  };
}
