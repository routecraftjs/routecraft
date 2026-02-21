import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Exchange } from "@routecraft/routecraft";

/** Store key for plugin-registered providers (provider id → LlmModelConfig). */
export const ADAPTER_LLM_PROVIDERS = Symbol.for(
  "routecraft.adapter.llm.providers",
);

/** Store key for context-level default LLM options. */
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
   * after the call. On success, the parsed value is set on LlmResult.value.
   */
  outputSchema?: StandardSchemaV1;
}

/** Internal merged type for adapter and store. */
export type LlmOptionsMerged = Required<
  Pick<LlmOptions, "temperature" | "maxTokens">
> &
  Omit<LlmOptions, "temperature" | "maxTokens">;

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmResult {
  content: string;
  usage?: LlmUsage;
  /** Raw provider response for advanced use. */
  raw?: unknown;
  /** Parsed structured output when outputSchema was set and validation succeeded. */
  value?: unknown;
}

export interface LlmPluginOptions {
  /**
   * Supported providers keyed by id. Only set options you need (defaults for url etc. apply).
   * Routes use llm("providerId:modelName"), e.g. llm("ollama:lfm2.5-thinking").
   */
  providers: LlmPluginProviders;
  /** Optional context-level default options (systemPrompt, temperature, etc.). */
  defaultOptions?: Partial<LlmOptionsMerged>;
}
