import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { ADAPTER_LLM_OPTIONS, ADAPTER_LLM_PROVIDERS } from "./types.ts";
import type { LlmModelConfig, LlmPluginOptions } from "./types.ts";
import { validateLlmPluginOptions } from "./validate-options.ts";

/** Normalize provider options to full LlmModelConfig (add provider field from key). */
function toModelConfig(
  providerId: string,
  opts: Record<string, unknown>,
): LlmModelConfig {
  return {
    provider: providerId as LlmModelConfig["provider"],
    ...opts,
  } as LlmModelConfig;
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

  return (ctx: CraftContext) => {
    const map = new Map<string, LlmModelConfig>();
    for (const [providerId, opts] of Object.entries(options.providers)) {
      if (opts !== undefined)
        map.set(
          providerId,
          toModelConfig(providerId, opts as Record<string, unknown>),
        );
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
  };
}
