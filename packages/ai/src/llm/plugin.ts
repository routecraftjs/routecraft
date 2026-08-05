import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { disposeCopilotProviderCache } from "./providers/resolve.ts";
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
  "lmstudio",
  "copilot",
  "custom",
] as const satisfies readonly LlmModelConfig["provider"][];

/** Normalize provider options to full LlmModelConfig (add provider field from key). */
function toModelConfig<P extends LlmModelConfig["provider"]>(
  providerId: P,
  opts: LlmProviderOptionsMap[P],
): Extract<LlmModelConfig, { provider: P }> {
  // Cast via `unknown`: the `custom` provider carries a function-typed
  // `model`, so a direct assertion is not comparable across the union.
  return { provider: providerId, ...opts } as unknown as Extract<
    LlmModelConfig,
    { provider: P }
  >;
}

/**
 * LLM plugin: registers providers and optional default options in the context store so
 * routes can use llm("providerId:modelName", options), e.g. llm("ollama:lfm2.5-thinking").
 * Key is the provider; only set options you need.
 *
 * Teardown stops any Copilot CLI clients started during the run. Every other provider
 * is config-only, so this hook is a no-op unless the copilot provider was used.
 *
 * Advanced users can set the store directly: context.setStore(ADAPTER_LLM_PROVIDERS, map)
 * and context.setStore(ADAPTER_LLM_OPTIONS, partialOptions) without using this plugin.
 * That path skips this teardown, so a copilot user going direct must call
 * disposeCopilotProviderCache() themselves.
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
      ctx.setStore(ADAPTER_LLM_PROVIDERS, map);
      if (
        options.defaultOptions &&
        Object.keys(options.defaultOptions).length > 0
      ) {
        ctx.setStore(ADAPTER_LLM_OPTIONS, options.defaultOptions);
      }
    },
    async teardown() {
      await disposeCopilotProviderCache();
    },
  };
}
