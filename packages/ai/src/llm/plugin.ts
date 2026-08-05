import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import {
  releaseCopilotClients,
  retainCopilotClients,
} from "./providers/resolve.ts";
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
 * Teardown stops any Copilot CLI clients started during the run, once the last context
 * using them has stopped (the client cache is process-wide, so concurrent contexts
 * sharing a client config share its CLI process). Only a plugin configured with the
 * copilot provider takes part in that refcount, and only once its `apply` has run:
 * `teardown` runs for every registered plugin even when init failed before reaching
 * this one, and an unpaired release could stop a client another context is still using.
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

  // Only the copilot provider owns a CLI process, so only a copilot config
  // takes part in the client refcount. `retainedCount` counts this instance's
  // live applies rather than being a flag: one plugin object can be applied to
  // several contexts (reusing a plugins array across builders does it), and
  // each of those contexts must hold its own reference, or the first teardown
  // would stop a client the others are still dispatching to. Counting also
  // keeps release paired, so a teardown for a context whose apply never ran
  // (init threw earlier in the plugin list) stays inert.
  const usesCopilot = options.providers.copilot !== undefined;
  let retainedCount = 0;

  return {
    apply(ctx: CraftContext) {
      if (usesCopilot) {
        retainCopilotClients();
        retainedCount += 1;
      }
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
      if (retainedCount === 0) return;
      retainedCount -= 1;
      await releaseCopilotClients();
    },
  };
}
