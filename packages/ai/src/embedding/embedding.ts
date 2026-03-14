import type { Destination } from "@routecraft/routecraft";
import { EmbeddingDestinationAdapter } from "./destination.ts";
import type {
  EmbeddingModelId,
  EmbeddingOptions,
  EmbeddingResult,
} from "./types.ts";

/**
 * Creates an embedding destination that computes a vector for the given text.
 * Use with .enrich(). Pass model id as "providerId:modelName" (e.g. huggingface:all-MiniLM-L6-v2).
 * The provider must be registered via embeddingPlugin({ providers: { huggingface: {} } }).
 *
 * @experimental
 * @param modelId - "providerId:modelName"; the provider is resolved from the plugin.
 * @param options - using(exchange) returns the string (or string[]) to embed.
 */
export function embedding<T = unknown>(
  modelId: EmbeddingModelId,
  options?: Partial<EmbeddingOptions<T>>,
): Destination<T, EmbeddingResult> {
  return new EmbeddingDestinationAdapter<T>(modelId, options);
}
