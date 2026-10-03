import { definePlugin, type Plugin } from "@routecraft/routecraft";
import { LLM } from "./types.ts";
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
 * LLM plugin: provides the {@link LLM} port with the configured providers and
 * optional default options, so routes can use llm("providerId:modelName", options),
 * e.g. llm("ollama:lfm2.5-thinking"). Key is the provider; only set options you need.
 */
export function llmPlugin(
  options: LlmPluginOptions = { providers: {} },
): Plugin {
  validateLlmPluginOptions(options);

  return definePlugin({
    id: "routecraft.ai.llm",
    provides: [LLM],
    bind(c) {
      const map = new Map<string, LlmModelConfig>();
      for (const providerId of PROVIDER_IDS) {
        const opts = options.providers[providerId];
        if (opts !== undefined)
          map.set(providerId, toModelConfig(providerId, opts));
      }
      const defaults =
        options.defaultOptions && Object.keys(options.defaultOptions).length > 0
          ? options.defaultOptions
          : undefined;
      c.provide(LLM, {
        providers: map,
        ...(defaults !== undefined ? { defaults } : {}),
      });
    },
  });
}
