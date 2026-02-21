import type { Destination } from "@routecraft/routecraft";
import { LlmAdapter } from "./adapter.ts";
import type { LlmOptions, LlmResult } from "./types.ts";

/**
 * Creates an LLM destination that calls a provider with a model. Use with .enrich() or .to().
 * Pass model id as "providerId:modelName" (e.g. ollama:lfm2.5-thinking). The provider must be
 * registered via llmPlugin({ providers: { ollama: { provider: "ollama" }, ... } }).
 *
 * @param modelId - "providerId:modelName"; the provider is resolved from the plugin, the model name is sent to the provider.
 * @param options - Optional overrides (systemPrompt, userPrompt, temperature, maxTokens, etc.). User prompt defaults to exchange.body.
 */
export function llm(
  modelId: string,
  options?: Partial<LlmOptions>,
): Destination<unknown, LlmResult> {
  return new LlmAdapter(modelId, options);
}
