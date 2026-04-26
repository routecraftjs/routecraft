import {
  rcError,
  type CraftContext,
  type CraftPlugin,
} from "@routecraft/routecraft";
import { validateAgentOptions } from "./agent.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
} from "./store.ts";
import { validateFnOptions } from "../fn/fn.ts";
import { ADAPTER_FN_REGISTRY } from "../fn/store.ts";
import { parseProviderModel } from "../llm/shared.ts";
import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";
import { isDeferredFn, type FnEntry } from "./tools/types.ts";
import { isToolSelection } from "./tools/selection.ts";

export interface AgentPluginOptions {
  /**
   * Agents available for by-name lookup via `agent("id")`. Keyed by the
   * agent id; each entry provides the agent's description, optional
   * model, system, and optional user-prompt override. Duplicate ids
   * across multiple `agentPlugin` installs throw at context init.
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
   * Context-level defaults applied to any agent that doesn't override
   * them. Mirrors the `llmPlugin({ defaultOptions })` pattern:
   *
   * - `model` (`LlmModelId` string) — used by agents that omit `model`.
   *   Requires `llmPlugin` to be installed with the relevant provider.
   * - `tools` (`ToolSelection` from `tools([...])`) — used by agents
   *   that omit `tools`. Override-not-extend; an explicit `tools:` on
   *   an agent replaces this default entirely.
   *
   * Multiple `agentPlugin` installs that each set the same default
   * field throw at context init.
   */
  defaultOptions?: AgentDefaultOptions;
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
  const defaultOptions = validatePluginDefaults(options.defaultOptions);
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

      if (defaultOptions !== undefined) {
        const existing = ctx.getStore(
          ADAPTER_AGENT_DEFAULT_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
        ) as AgentDefaultOptions | undefined;
        const merged = mergePluginDefaults(existing, defaultOptions);
        ctx.setStore(
          ADAPTER_AGENT_DEFAULT_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
          merged,
        );
      }
    },
  };
}

/**
 * Validate the shape of `agentPlugin({ defaultOptions: ... })` at
 * plugin-construction time. Returns the validated value (with no
 * mutations) or undefined when no defaults were supplied.
 *
 * @internal
 */
function validatePluginDefaults(
  raw: AgentDefaultOptions | undefined,
): AgentDefaultOptions | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions" must be an object with optional "model" / "tools".`,
    });
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "defaultOptions.model" must be a non-empty "providerId:modelName" string.`,
      });
    }
    try {
      parseProviderModel(raw.model);
    } catch {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "defaultOptions.model" must be in "providerId:modelName" form (e.g. anthropic:claude-opus-4-7). Got: "${raw.model}"`,
      });
    }
  }
  if (raw.tools !== undefined && !isToolSelection(raw.tools)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.tools" must be the result of tools([...]).`,
    });
  }
  return raw;
}

/**
 * Merge a freshly-supplied `defaultOptions` into the value already
 * stored by a previous `agentPlugin` install. Per-field conflicts
 * throw so a context cannot accidentally end up with two competing
 * defaults for the same field.
 *
 * @internal
 */
function mergePluginDefaults(
  existing: AgentDefaultOptions | undefined,
  next: AgentDefaultOptions,
): AgentDefaultOptions {
  if (!existing) return { ...next };
  if (next.model !== undefined && existing.model !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.model" is already set on this context. A context can have only one default model.`,
    });
  }
  if (next.tools !== undefined && existing.tools !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.tools" is already set on this context. Combine selectors into a single tools([...]) call.`,
    });
  }
  return {
    ...existing,
    ...(next.model !== undefined ? { model: next.model } : {}),
    ...(next.tools !== undefined ? { tools: next.tools } : {}),
  };
}
