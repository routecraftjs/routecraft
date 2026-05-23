import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { ADAPTER_LLM_OPTIONS, ADAPTER_LLM_PROVIDERS } from "./types.ts";
import type {
  LlmModelConfig,
  LlmPluginOptions,
  LlmProviderOptionsMap,
} from "./types.ts";
import { validateLlmPluginOptions } from "./validate-options.ts";

const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "ollama",
  "gemini",
] as const satisfies readonly LlmModelConfig["provider"][];

/** Normalize provider options to full LlmModelConfig (add provider field from key). */
function toModelConfig<P extends LlmModelConfig["provider"]>(
  providerId: P,
  opts: LlmProviderOptionsMap[P],
): Extract<LlmModelConfig, { provider: P }> {
  return { provider: providerId, ...opts } as Extract<
    LlmModelConfig,
    { provider: P }
  >;
}

/**
 * LLM plugin: config-only helper (no lifecycle hooks). Registers providers and optional
 * default options in the context store so routes can use llm("providerId:modelName", options),
 * e.g. llm("ollama:lfm2.5-thinking"). Key is the provider; only set options you need.
 *
 * Advanced users can set the store directly: context.setStore(ADAPTER_LLM_PROVIDERS, map)
 * and context.setStore(ADAPTER_LLM_OPTIONS, partialOptions) without using this plugin.
 */
export function llmPlugin(
  options: LlmPluginOptions = { providers: {} },
): CraftPlugin {
  validateLlmPluginOptions(options);

  return {
    apply(ctx: CraftContext) {
      const map = new Map<string, LlmModelConfig>();
      for (const providerId of PROVIDER_IDS) {
        const opts = options.providers[providerId];
        if (opts !== undefined)
          map.set(providerId, toModelConfig(providerId, opts));
      }
      ctx.setStore(
        ADAPTER_LLM_PROVIDERS as keyof import("@routecraft/routecraft").StoreRegistry,
        map,
      );
      if (
        options.defaultOptions &&
        Object.keys(options.defaultOptions).length > 0
      ) {
        ctx.setStore(
          ADAPTER_LLM_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
          options.defaultOptions,
        );
      }
    },
  };
}
