import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Exchange } from "@routecraft/routecraft";

/**
 * Store key for plugin-registered providers (provider id -> LlmModelConfig).
 * @experimental
 */
export const ADAPTER_LLM_PROVIDERS = Symbol.for(
  "routecraft.adapter.llm.providers",
);

/**
 * Store key for context-level default LLM options.
 * @experimental
 */
export const ADAPTER_LLM_OPTIONS = Symbol.for("routecraft.adapter.llm.options");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_LLM_PROVIDERS]: Map<string, LlmModelConfig>;
    [ADAPTER_LLM_OPTIONS]: Partial<LlmOptionsMerged>;
  }
}

export type LlmProviderType =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "gemini";

export interface LlmModelConfigOpenAI {
  provider: "openai";
  apiKey: string;
  baseURL?: string;
}

export interface LlmModelConfigAnthropic {
  provider: "anthropic";
  apiKey: string;
}

export interface LlmModelConfigOpenRouter {
  provider: "openrouter";
  apiKey: string;
  /** OpenRouter model id (e.g. anthropic/claude-3.5-sonnet). Defaults to the registered key. */
  modelId?: string;
}

export interface LlmModelConfigOllama {
  provider: "ollama";
  /**
   * Ollama server URL. Optional: defaults to http://localhost:11434/api.
   * Only set when using a remote Ollama or custom port.
   */
  baseURL?: string;
  /**
   * Override model name sent to Ollama. Optional: defaults to the model
   * from the llm("provider:model") call (the part after the colon).
   */
  modelId?: string;
}

export interface LlmModelConfigGemini {
  provider: "gemini";
  apiKey: string;
}

export type LlmModelConfig =
  | LlmModelConfigOpenAI
  | LlmModelConfigAnthropic
  | LlmModelConfigOpenRouter
  | LlmModelConfigOllama
  | LlmModelConfigGemini;

/** Provider options for llmPlugin({ providers }). Key is the provider; no need to repeat provider in the value. */
export interface LlmOllamaProviderOptions {
  baseURL?: string;
  modelId?: string;
}
export interface LlmOpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
}
export interface LlmAnthropicProviderOptions {
  apiKey: string;
}
export interface LlmOpenRouterProviderOptions {
  apiKey: string;
  modelId?: string;
}
export interface LlmGeminiProviderOptions {
  apiKey: string;
}

export interface LlmPluginProviders {
  ollama?: LlmOllamaProviderOptions;
  openai?: LlmOpenAIProviderOptions;
  anthropic?: LlmAnthropicProviderOptions;
  openrouter?: LlmOpenRouterProviderOptions;
  gemini?: LlmGeminiProviderOptions;
}

/** Map provider id → provider-specific options (for type-safe toModelConfig). */
export type LlmProviderOptionsMap = Required<LlmPluginProviders>;

/** Resolve system or user prompt from exchange (string or function). */
export type LlmPromptSource =
  | string
  | ((exchange: Exchange<unknown>) => string);

export interface LlmOptions {
  systemPrompt?: LlmPromptSource;
  userPrompt?: LlmPromptSource;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /**
   * Optional output schema (Standard Schema). When set, the adapter requests
   * provider-level structured output and validates the result. Supported by
   * OpenAI (gpt-4o/mini) and Ollama; others may return JSON that is validated
   * after the call. On success, the parsed value is set on LlmResult.output.
   */
  outputSchema?: StandardSchemaV1;
}

/** Internal merged type for adapter and store. */
export type LlmOptionsMerged = Required<
  Pick<LlmOptions, "temperature" | "maxTokens">
> &
  Omit<LlmOptions, "temperature" | "maxTokens">;

/**
 * Token usage. Matches Vercel AI SDK LanguageModelUsage shape (inputTokens/outputTokens)
 * so result.usage can be used interchangeably with generateText() return value.
 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * LLM result shape aligned with Vercel AI SDK generateText() return value.
 * Same property names (text, output, usage) so code and docs transfer directly.
 */
export interface LlmResult {
  /** Generated text (raw string from the model). */
  text: string;
  /** Parsed structured output when outputSchema was set and validation succeeded. */
  output?: unknown;
  /** Token usage for the last step. Same shape as AI SDK usage. */
  usage?: LlmUsage;
  /** Full generateText() result for advanced use (debugging, response metadata). */
  raw?: unknown;
}

/**
 * When outputSchema S is provided to llm(), the result type narrows output to InferOutput<S>.
 * Used for type inference from llm(modelId, { outputSchema }) so body.output is typed downstream.
 */
export type LlmResultWithOutput<S extends StandardSchemaV1 | undefined> =
  S extends StandardSchemaV1
    ? Omit<LlmResult, "output"> & {
        output?: StandardSchemaV1.InferOutput<S>;
      }
    : LlmResult;

/**
 * Recommended LLM model ids for autocomplete (chat/completion use cases).
 * Format: "providerId:modelName". Custom models are allowed via string.
 * Updated for 2026.
 */
export type LlmModelId =
  // OpenAI (2026: GPT-5.2, Codex, o1)
  | "openai:gpt-5.2"
  | "openai:gpt-5.2-codex"
  | "openai:gpt-5"
  | "openai:gpt-5.1-chat-latest"
  | "openai:gpt-5-mini"
  | "openai:gpt-5-codex-mini"
  | "openai:gpt-4o"
  | "openai:gpt-4o-mini"
  | "openai:o1"
  | "openai:o1-mini"
  // Anthropic (2026: Claude 4.6 / 4.5)
  | "anthropic:claude-opus-4-6"
  | "anthropic:claude-sonnet-4-6"
  | "anthropic:claude-haiku-4-5"
  // Ollama (common local models)
  | "ollama:qwen3"
  | "ollama:llama3.2"
  | "ollama:llama3.3"
  | "ollama:mistral"
  | "ollama:gemma2"
  | "ollama:deepseek-r1"
  | "ollama:lfm2.5-thinking"
  // OpenRouter (top open-weight / frontier: GLM, Kimi, Qwen, DeepSeek)
  | "openrouter:z-ai/glm-5"
  | "openrouter:z-ai/glm-4.7"
  | "openrouter:moonshotai/kimi-k2-thinking"
  | "openrouter:qwen/qwen3.5-plus-02-15"
  | "openrouter:qwen/qwen3-next"
  | "openrouter:deepseek/deepseek-v3.2"
  | "openrouter:deepseek/deepseek-r1"
  | "openrouter:meta-llama/llama-3.3-70b-instruct"
  // Gemini (2026: 2.5 + 3.x preview)
  | "gemini:gemini-2.5-pro"
  | "gemini:gemini-2.5-flash"
  | "gemini:gemini-2.5-flash-lite"
  | "gemini:gemini-3.1-pro-preview"
  | "gemini:gemini-3-pro-preview"
  | "gemini:gemini-3-flash-preview"
  // Other (custom models)
  | string;

export interface LlmPluginOptions {
  /**
   * Supported providers keyed by id. Only set options you need (defaults for url etc. apply).
   * Routes use llm("providerId:modelName"), e.g. llm("ollama:lfm2.5-thinking").
   */
  providers: LlmPluginProviders;
  /** Optional context-level default options (systemPrompt, temperature, etc.). */
  defaultOptions?: Partial<LlmOptionsMerged>;
}
