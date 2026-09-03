import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Enricher } from "@routecraft/routecraft";
import { tagAdapter, factoryArgs } from "@routecraft/routecraft";
import { LlmEnricherAdapter } from "./enricher.ts";
import type { LlmOptions, LlmResultWithOutput } from "./types.ts";
import type { RegisteredLlmModelId } from "../registry.ts";

/**
 * Creates an LLM destination that calls a provider with a model. Use with .enrich() or .to().
 * Pass model id as "providerId:modelName" (e.g. ollama:lfm2.5-thinking). The provider must be
 * registered via llmPlugin({ providers: { ollama: { provider: "ollama" }, ... } }).
 * When options.output is provided, the result type narrows so body.output is typed downstream.
 *
 * @param modelId - "providerId:modelName"; the provider is resolved from the plugin, the model name is sent to the provider.
 * @param options - Optional overrides (system, user, temperature, maxTokens, output, etc.). User prompt defaults to exchange.body.
 */
export function llm<
  S extends StandardSchemaV1 | undefined = undefined,
  T = unknown,
>(
  modelId: RegisteredLlmModelId,
  options?: LlmOptions<T> & { output?: S },
): Enricher<T, LlmResultWithOutput<S>> {
  return tagAdapter(
    new LlmEnricherAdapter<S, T>(modelId, options),
    llm,
    factoryArgs(modelId, options),
  );
}
