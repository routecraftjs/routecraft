import type { Exchange } from "@routecraft/routecraft";

/** Store key for plugin-registered embedding providers (provider id → EmbeddingModelConfig). */
export const ADAPTER_EMBEDDING_PROVIDERS = Symbol.for(
  "routecraft.adapter.embedding.providers",
);

/** Store key for context-level default embedding options. */
export const ADAPTER_EMBEDDING_OPTIONS = Symbol.for(
  "routecraft.adapter.embedding.options",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_EMBEDDING_PROVIDERS]: Map<string, EmbeddingModelConfig>;
    [ADAPTER_EMBEDDING_OPTIONS]: Partial<EmbeddingOptionsMerged>;
  }
}

export interface EmbeddingModelConfigHuggingFace {
  provider: "huggingface";
}

export interface EmbeddingModelConfigOllama {
  provider: "ollama";
  baseURL?: string;
}

export interface EmbeddingModelConfigOpenAI {
  provider: "openai";
  apiKey: string;
  baseURL?: string;
}

/** Used by tests only: returns a deterministic vector, no model download. */
export interface EmbeddingModelConfigMock {
  provider: "mock";
}

export type EmbeddingModelConfig =
  | EmbeddingModelConfigHuggingFace
  | EmbeddingModelConfigOllama
  | EmbeddingModelConfigOpenAI
  | EmbeddingModelConfigMock;

export type EmbeddingProviderType =
  | "huggingface"
  | "ollama"
  | "openai"
  | "mock";

export interface EmbeddingOptions<T = unknown> {
  /** Build the string to embed from the exchange (e.g. jobTitle + location). */
  using: (exchange: Exchange<T>) => string | string[];
}

export type EmbeddingOptionsMerged = EmbeddingOptions;

export interface EmbeddingResult {
  embedding: number[];
}

/** Provider options for embeddingPlugin({ providers }). Key is the provider id. */
export interface EmbeddingPluginProviders {
  huggingface?: Record<string, never>;
  ollama?: { baseURL?: string };
  openai?: { apiKey: string; baseURL?: string };
  /** Test-only: deterministic vector, no network. */
  mock?: Record<string, never>;
}

export interface EmbeddingPluginOptions {
  providers: EmbeddingPluginProviders;
  /** Optional context-level default options. */
  defaultOptions?: Partial<EmbeddingOptionsMerged>;
}

/**
 * Recommended embedding model ids for autocomplete.
 * Format: "providerId:modelName". Custom models are allowed via string.
 * Updated for 2026.
 */
export type EmbeddingModelId =
  // HuggingFace
  | "huggingface:all-MiniLM-L6-v2"
  | "huggingface:sentence-transformers/all-MiniLM-L6-v2"
  | "huggingface:sentence-transformers/all-mpnet-base-v2"
  | "huggingface:BAAI/bge-small-en-v1.5"
  | "huggingface:BAAI/bge-base-en-v1.5"
  | "huggingface:BAAI/bge-m3"
  | "huggingface:intfloat/e5-small-v2"
  | "huggingface:intfloat/e5-base-v2"
  | "huggingface:intfloat/multilingual-e5-large"
  // OpenAI
  | "openai:text-embedding-3-small"
  | "openai:text-embedding-3-large"
  | "openai:text-embedding-ada-002"
  // Ollama
  | "ollama:nomic-embed-text"
  | "ollama:nomic-embed-text-v1.5"
  | "ollama:mxbai-embed-large"
  | "ollama:all-minilm"
  // Other (custom models)
  | string;
