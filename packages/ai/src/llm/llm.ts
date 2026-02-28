import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Destination } from "@routecraft/routecraft";
import { LlmAdapter } from "./adapter.ts";
import type { LlmModelId, LlmOptions, LlmResultWithOutput } from "./types.ts";

/**
 * Creates an LLM destination that calls a provider with a model. Use with .enrich() or .to().
 * Pass model id as "providerId:modelName" (e.g. ollama:lfm2.5-thinking). The provider must be
 * registered via llmPlugin({ providers: { ollama: { provider: "ollama" }, ... } }).
 * When options.outputSchema is provided, the result type narrows so body.output is typed downstream.
 *
 * @param modelId - "providerId:modelName"; the provider is resolved from the plugin, the model name is sent to the provider.
 * @param options - Optional overrides (systemPrompt, userPrompt, temperature, maxTokens, outputSchema, etc.). User prompt defaults to exchange.body.
 */
export function llm<S extends StandardSchemaV1 | undefined = undefined>(
  modelId: LlmModelId,
  options?: Partial<LlmOptions> & { outputSchema?: S },
): Destination<unknown, LlmResultWithOutput<S>> {
  return new LlmAdapter<S>(modelId, options);
}
