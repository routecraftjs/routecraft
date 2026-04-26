import {
  getExchangeContext,
  getExchangeRoute,
  rcError,
  type CraftContext,
  type Destination,
  type Exchange,
} from "@routecraft/routecraft";
import { resolveModel } from "../llm/shared.ts";
import { AgentSession, buildUserPrompt } from "./session.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
} from "./store.ts";
import type { ResolvedTool } from "./tools/selection.ts";
import type {
  AgentDefaultOptions,
  AgentOptions,
  AgentRegisteredOptions,
  AgentResult,
} from "./types.ts";

const AGENT_REGISTRY_STORE_DESCRIPTION =
  ADAPTER_AGENT_REGISTRY.description ?? "routecraft.adapter.agent.registry";

/** Discriminated state: inline options or a registry name. */
export type AgentBinding =
  | { kind: "inline"; options: AgentOptions }
  | { kind: "by-name"; name: string };

/**
 * Agent destination adapter. Resolves agent options (inline or
 * registered), merges them with `agentPlugin({ defaultOptions })`,
 * resolves the agent's tool selection against the live context, and
 * dispatches the tool-calling loop via {@link AgentSession}. Replaces
 * the exchange body with `AgentResult { text, output?, reasoning?, usage? }`.
 *
 * Resolution: when constructed inline, uses options directly. When
 * constructed by name, resolves the registered agent from the context
 * store (`ADAPTER_AGENT_REGISTRY`) at dispatch time, throwing a clear
 * error if the name is unknown.
 *
 * @experimental
 */
export class AgentDestinationAdapter implements Destination<
  unknown,
  AgentResult
> {
  readonly adapterId = "routecraft.adapter.agent";

  constructor(public readonly binding: AgentBinding) {}

  async send(exchange: Exchange<unknown>): Promise<AgentResult> {
    const context = getExchangeContext(exchange);
    const baseOptions = this.resolveOptions(context);
    const merged = mergeWithDefaults(baseOptions, context);

    if (merged.model === undefined) {
      throw rcError("RC5003", undefined, {
        message:
          `Agent: no "model" supplied and no agentPlugin({ defaultOptions: { model } }) is set on this context. ` +
          `Specify "model" on the agent or set a context-level default.`,
      });
    }

    const { config, modelName } = resolveModel(merged.model, context);
    const tools = resolveAgentTools(merged, context);
    const user = buildUserPrompt(merged, exchange);

    const session = new AgentSession({
      options: merged,
      modelConfig: config,
      modelName,
      tools,
      user,
      system: merged.system,
      context,
    });

    // Thread the route's abort signal through so the agent dispatch
    // (LLM call + in-flight tool handlers) is cancelled when the
    // route or context shuts down. Falls back to a never-firing
    // signal when the exchange has no route binding (rare; mostly
    // synthetic exchanges in tests).
    const abortSignal =
      getExchangeRoute(exchange)?.signal ?? new AbortController().signal;
    return await session.runUntilDone(abortSignal);
  }

  /** Pull the agent options for this dispatch, either inline or from the registry. */
  private resolveOptions(
    context: CraftContext | undefined,
  ): AgentOptions | AgentRegisteredOptions {
    if (this.binding.kind === "inline") return this.binding.options;

    if (!context) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" requires a context to resolve. ` +
          `Ensure the exchange has context (e.g. from a route) so the ` +
          `"${AGENT_REGISTRY_STORE_DESCRIPTION}" store can be read.`,
      });
    }
    const registry = context.getStore(
      ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, AgentRegisteredOptions> | undefined;
    if (!registry) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" not found: no agents registered. ` +
          `Add agentPlugin({ agents: { "${this.binding.name}": {...} } }) to your config.`,
      });
    }
    const found = registry.get(this.binding.name);
    if (!found) {
      const known = Array.from(registry.keys()).join(", ") || "<none>";
      throw rcError("RC5004", undefined, {
        message: `Agent "${this.binding.name}" not found in registry. Known agents: ${known}.`,
      });
    }
    return found;
  }

  /**
   * Extract metadata from the agent result for observability. Includes the
   * resolved model (as string) and token usage when reported.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const r = result as AgentResult;
    const metadata: Record<string, unknown> = {};
    if (this.binding.kind === "by-name") metadata["agent"] = this.binding.name;
    if (this.binding.kind === "inline") {
      const model = this.binding.options.model;
      if (typeof model === "string") metadata["model"] = model;
    }
    if (r.usage?.inputTokens !== undefined) {
      metadata["inputTokens"] = r.usage.inputTokens;
    }
    if (r.usage?.outputTokens !== undefined) {
      metadata["outputTokens"] = r.usage.outputTokens;
    }
    return metadata;
  }
}

/**
 * Merge per-agent options with the context-level defaults registered
 * via `agentPlugin({ defaultOptions: {...} })`. Per-agent values win
 * per key; missing fields fall back to defaults (mirrors the LLM
 * destination's `mergedOptions` pattern).
 *
 * @internal
 */
function mergeWithDefaults(
  base: AgentOptions | AgentRegisteredOptions,
  context: CraftContext | undefined,
): AgentOptions | AgentRegisteredOptions {
  const defaults = context?.getStore(
    ADAPTER_AGENT_DEFAULT_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as AgentDefaultOptions | undefined;
  if (!defaults) return base;
  const out = { ...base } as AgentOptions | AgentRegisteredOptions;
  if (out.model === undefined && defaults.model !== undefined) {
    out.model = defaults.model;
  }
  if (out.tools === undefined && defaults.tools !== undefined) {
    out.tools = defaults.tools;
  }
  if (out.maxSteps === undefined && defaults.maxSteps !== undefined) {
    out.maxSteps = defaults.maxSteps;
  }
  return out;
}

/**
 * Resolve the agent's `tools` selection against the live context. The
 * selection is the `ToolSelection` object built via `tools([...])`;
 * resolution walks the fn registry and direct registry to produce the
 * final `ResolvedTool[]` the runtime hands to the LLM.
 *
 * Returns an empty array when the agent has no tools field set
 * (and no context-default tools were inherited).
 *
 * @internal
 */
function resolveAgentTools(
  options: AgentOptions | AgentRegisteredOptions,
  context: CraftContext | undefined,
): ResolvedTool[] {
  if (options.tools === undefined) return [];
  if (!context) {
    throw rcError("RC5003", undefined, {
      message: `Agent: cannot resolve tools without a CraftContext.`,
    });
  }
  return options.tools.resolve(context);
}
