import {
  rcError,
  type CraftContext,
  type CraftPlugin,
} from "@routecraft/routecraft";
import { validateAgentOptions } from "./agent.ts";
import { ADAPTER_AGENT_REGISTRY, ADAPTER_TOOLS_DEFAULT } from "./store.ts";
import { validateFnOptions } from "../fn/fn.ts";
import { ADAPTER_FN_REGISTRY } from "../fn/store.ts";
import type { AgentRegisteredOptions } from "./types.ts";
import { isDeferredFn, type FnEntry } from "./tools/types.ts";
import { isToolSelection, type ToolSelection } from "./tools/selection.ts";

export interface AgentPluginOptions {
  /**
   * Agents available for by-name lookup via `agent("id")`. Keyed by the
   * agent id; each entry provides the agent's description, model, system,
   * and optional user-prompt override. Duplicate ids across multiple
   * `agentPlugin` installs throw at context init.
   */
  agents?: Record<string, AgentRegisteredOptions>;

  /**
   * Ad-hoc in-process functions available to agents (via `tools: [...]`
   * in follow-up stories). Keyed by the fn id; each entry is either an
   * eagerly-authored `FnOptions` (description, schema, handler) or a
   * deferred descriptor emitted by a builder helper such as
   * `directTool(routeId)` / `agentTool(agentId)` / `mcpTool(server, tool)`.
   * Deferred descriptors resolve at agent dispatch time when all
   * registries are populated.
   *
   * Duplicate ids across multiple `agentPlugin` installs throw at
   * context init.
   *
   * For tests, exercise registered fn handlers via `testFn` from
   * `@routecraft/testing` rather than dispatching through the plugin.
   */
  functions?: Record<string, FnEntry>;

  /**
   * Context-default tool list for agents that don't specify their own
   * `tools:` field. Build via `tools([...])`. An agent that does set
   * `tools:` replaces this default entirely (override, not extend).
   *
   * Multiple `agentPlugin` installs that each provide a default throw
   * at context init: a context can only have one default tool list.
   */
  tools?: ToolSelection;
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
 * routes can reference agents by name via `agent("id")` and so fns are
 * available to tool-using agents (the agent tool loop dispatches them
 * directly; there is no public dispatch API). Throws on duplicate id
 * (within agents, within fns, or across multiple plugin installs) at
 * context init.
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
  const defaultTools = options.tools;
  if (defaultTools !== undefined && !isToolSelection(defaultTools)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "tools" must be the result of tools([...]).`,
    });
  }
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
        if (entry === null || typeof entry !== "object") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent "${id}" entry must be an object with description, model, and system.`,
          });
        }
        if (entry.tools !== undefined && !isToolSelection(entry.tools)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent "${id}" "tools" must be the result of tools([...]).`,
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
      ) as Map<string, FnEntry> | undefined;
      const fnMap = existingFns ?? new Map<string, FnEntry>();
      for (const [id, entry] of Object.entries(functions)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: fn id must be a non-empty string.`,
          });
        }
        if (entry === null || typeof entry !== "object") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: fn "${id}" entry must be an object with description, schema, and handler.`,
          });
        }
        if (!isDeferredFn(entry)) {
          validateFnOptions(id, entry);
        }
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

      if (defaultTools !== undefined) {
        const existingDefault = ctx.getStore(
          ADAPTER_TOOLS_DEFAULT as keyof import("@routecraft/routecraft").StoreRegistry,
        );
        if (existingDefault !== undefined) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: a default tool list is already set on this context. Combine selectors into a single tools([...]) call.`,
          });
        }
        ctx.setStore(
          ADAPTER_TOOLS_DEFAULT as keyof import("@routecraft/routecraft").StoreRegistry,
          defaultTools,
        );
      }
    },
  };
}
