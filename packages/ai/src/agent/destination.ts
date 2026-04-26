import {
  getExchangeContext,
  rcError,
  type CraftContext,
  type Destination,
  type Exchange,
} from "@routecraft/routecraft";
import { callLlm } from "../llm/providers/index.ts";
import {
  resolveModel,
  resolvePrompt,
  resolveUserPromptDefault,
} from "../llm/shared.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
} from "./store.ts";
import type {
  AgentDefaultOptions,
  AgentOptions,
  AgentRegisteredOptions,
  AgentResult,
} from "./types.ts";

/** Default sampling settings; aligned with the LLM destination defaults. */
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 1024;

const AGENT_REGISTRY_STORE_DESCRIPTION =
  ADAPTER_AGENT_REGISTRY.description ?? "routecraft.adapter.agent.registry";

/** Discriminated state: inline options or a registry name. */
export type AgentBinding =
  | { kind: "inline"; options: AgentOptions }
  | { kind: "by-name"; name: string };

/**
 * Agent destination adapter. Calls the configured LLM provider once with the
 * agent's system prompt and a user prompt derived from the exchange body.
 * Replaces the body with `AgentResult { text, usage? }`.
 *
 * Resolution: when constructed inline, uses options directly. When
 * constructed by name, resolves the registered agent from the context store
 * (`ADAPTER_AGENT_REGISTRY`) at dispatch time, throwing a clear error if
 * the name is unknown.
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

    const systemPrompt = merged.system;
    const userPrompt =
      merged.user !== undefined
        ? resolvePrompt(merged.user, exchange)
        : resolveUserPromptDefault(exchange);

    const result = await callLlm({
      config,
      modelId: modelName,
      options: {
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: DEFAULT_MAX_TOKENS,
      },
      systemPrompt,
      userPrompt,
    });

    const out: AgentResult = { text: result.text };
    if (result.usage) out.usage = result.usage;
    return out;
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
          `Add agentPlugin({ agents: [defineAgent({ id: "${this.binding.name}", ... })] }) to your config.`,
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
  return out;
}
