export { EmbeddingEnricherAdapter } from "./enricher.ts";
export { embedding } from "./embedding.ts";
export { embeddingPlugin } from "./plugin.ts";
export { EMBEDDING, type EmbeddingService } from "./types.ts";
export { disposeEmbeddingPipelineCache } from "./providers/index.ts";
export type {
  EmbeddingModelConfig,
  EmbeddingModelConfigHuggingFace,
  EmbeddingModelConfigOllama,
  EmbeddingModelConfigOpenAI,
  EmbeddingModelId,
  EmbeddingOptions,
  EmbeddingPluginOptions,
  EmbeddingPluginProviders,
  EmbeddingProviderType,
  EmbeddingResult,
} from "./types.ts";
