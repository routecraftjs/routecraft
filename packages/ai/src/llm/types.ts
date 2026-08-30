import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Exchange } from "@routecraft/routecraft";

/**
 * A model object the active LLM engine can drive (today an AI SDK
 * `LanguageModel`), or anything else a future engine accepts. Deliberately
 * `unknown` so no engine-specific type reaches the public surface: every other
 * provider is addressed by a `"provider:model"` string and the framework's own
 * `LlmOptions`/`LlmResult` types, so swapping the underlying SDK does not break
 * consumers. The `custom` provider is the one engine-bound escape hatch, and we
 * keep that binding a runtime contract (validated by `assertLanguageModelShape`)
 * rather than a compile-time coupling.
 */
export type CustomLanguageModel = unknown;

/**
 * Store key for plugin-registered providers (provider id -> LlmModelConfig).
 * @internal
 */
export const ADAPTER_LLM_PROVIDERS = Symbol.for(
  "routecraft.adapter.llm.providers",
);

/**
 * Store key for context-level default LLM options.
 * @internal
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
  | "gemini"
  | "lmstudio"
  | "custom";

export interface LlmModelConfigOpenAI {
  provider: "openai";
  apiKey: string;
  baseURL?: string;
}

export interface LlmModelConfigAnthropic {
  provider: "anthropic";
  apiKey: string;
  /**
   * Anthropic API URL. Optional: the SDK default applies when unset.
   * Set it to route through a gateway or proxy. Configuring it here wins
   * over the ambient `ANTHROPIC_BASE_URL` environment variable, which the
   * SDK falls back to when no explicit URL is passed.
   */
  baseURL?: string;
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
  /**
   * Gemini API URL. Optional: the SDK default applies when unset.
   * Set it to route through a gateway or proxy.
   */
  baseURL?: string;
}

export interface LlmModelConfigLmStudio {
  provider: "lmstudio";
  /**
   * LM Studio server URL. Optional: defaults to http://localhost:1234/v1.
   * Only set when LM Studio runs on a non-default host or port.
   */
  baseURL?: string;
  /**
   * API key sent to LM Studio. Optional: LM Studio ignores authentication,
   * so this defaults to a placeholder. Set it only if you front LM Studio
   * with a proxy that enforces a key.
   */
  apiKey?: string;
  /**
   * Override model name sent to LM Studio. Optional: defaults to the model
   * from the llm("lmstudio:model") call (the part after the colon).
   */
  modelId?: string;
}

export interface LlmModelConfigCustom {
  provider: "custom";
  /**
   * A pre-built AI SDK language model, or a factory that builds one from the
   * model name (the part after the colon in llm("custom:name")). This is the
   * escape hatch for running an agent or llm() step against an in-process or
   * otherwise unsupported model with no API key and no network.
   */
  model: CustomLanguageModel | ((modelId: string) => CustomLanguageModel);
  /**
   * Optional model name. Only needed when using an inline config object with
   * a factory; the string form llm("custom:name") supplies it directly.
   */
  modelId?: string;
}

export type LlmModelConfig =
  | LlmModelConfigOpenAI
  | LlmModelConfigAnthropic
  | LlmModelConfigOpenRouter
  | LlmModelConfigOllama
  | LlmModelConfigGemini
  | LlmModelConfigLmStudio
  | LlmModelConfigCustom;

/**
 * Provider options for llmPlugin({ providers }). Key is the provider; no need to repeat provider in the value.
 */
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
  baseURL?: string;
}
export interface LlmOpenRouterProviderOptions {
  apiKey: string;
  modelId?: string;
}
export interface LlmGeminiProviderOptions {
  apiKey: string;
  baseURL?: string;
}
export interface LlmLmStudioProviderOptions {
  baseURL?: string;
  apiKey?: string;
  modelId?: string;
}
export interface LlmCustomProviderOptions {
  model: CustomLanguageModel | ((modelId: string) => CustomLanguageModel);
  modelId?: string;
}

export interface LlmPluginProviders {
  ollama?: LlmOllamaProviderOptions;
  openai?: LlmOpenAIProviderOptions;
  anthropic?: LlmAnthropicProviderOptions;
  openrouter?: LlmOpenRouterProviderOptions;
  gemini?: LlmGeminiProviderOptions;
  lmstudio?: LlmLmStudioProviderOptions;
  custom?: LlmCustomProviderOptions;
}

/** Map provider id → provider-specific options (for type-safe toModelConfig). */
export type LlmProviderOptionsMap = Required<LlmPluginProviders>;

/**
 * Resolve system or user prompt from exchange (string or function).
 */
export type LlmPromptSource =
  string | ((exchange: Exchange<unknown>) => string);

/**
 * Normalised reasoning effort, the portable way to ask a model to think more
 * or less about one call. Mapped to each provider's own control at dispatch
 * (see `providers/reasoning.ts` for the table, and the llm adapter reference
 * for the user-facing version of it).
 *
 * A level a provider cannot express maps to the nearest level it supports
 * rather than throwing, because an option that refuses on some providers is
 * not portable and portability is the whole point. Where that matters, the
 * mapping table says so: Gemini has no way to turn thinking off, so `"none"`
 * reaches it as its lowest level, and Ollama's control is a boolean, so the
 * three non-zero levels are indistinguishable there.
 */
export type LlmReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * Raw provider settings, forwarded to the SDK verbatim as its
 * `providerOptions`. The labelled escape hatch for anything the normalised
 * options cannot express (Anthropic's thinking token budget, Gemini's
 * `thinkingBudget`, a provider setting the framework has no opinion about).
 *
 * Keyed by the SDK's provider namespace, which is not always the Routecraft
 * provider id: `gemini` reaches the SDK as `google`.
 *
 * Unportable by construction, which is why it sits beside the normalised
 * options rather than replacing them. It wins over {@link LlmReasoningEffort}
 * for the keys it names, so a route can take the mapping for everything else
 * and still hand one provider a value of its own.
 */
export type LlmRawProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Sampling and reasoning controls. Shared verbatim by `llm()` and `agent()`
 * so the same dial means the same thing wherever a model is called.
 */
export interface LlmSamplingOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /**
   * How much the model should reason about this call, normalised across
   * providers. Omitted means the provider's own default applies; nothing is
   * sent. See {@link LlmReasoningEffort} for what each level maps to.
   */
  reasoning?: LlmReasoningEffort;
  /**
   * Raw provider settings forwarded to the SDK. Merged over whatever
   * `reasoning` mapped to, per provider namespace and per setting within it,
   * so naming a setting here replaces the mapped one and leaves the rest.
   * See {@link LlmRawProviderOptions}.
   */
  providerOptions?: LlmRawProviderOptions;
}

export interface LlmOptions extends LlmSamplingOptions {
  system?: LlmPromptSource;
  user?: LlmPromptSource;
  /**
   * Optional output schema (Standard Schema). When set, the adapter requests
   * provider-level structured output and validates the result. Supported by
   * OpenAI (gpt-4o/mini) and Ollama; others may return JSON that is validated
   * after the call. On success, the parsed value is set on LlmResult.output.
   *
   * Mirrors the route-level `.output(schema)` naming so the same word is
   * used for "declared output shape" everywhere in the framework.
   */
  output?: StandardSchemaV1;
}

/**
 * The sampling block after defaults are applied: `temperature` and
 * `maxTokens` always have a value, everything else is present only when the
 * author asked for it. This is what reaches the provider call.
 */
export type LlmSamplingOptionsMerged = Required<
  Pick<LlmSamplingOptions, "temperature" | "maxTokens">
> &
  Omit<LlmSamplingOptions, "temperature" | "maxTokens">;

/** Internal merged type for adapter and store. */
export type LlmOptionsMerged = LlmSamplingOptionsMerged &
  Omit<LlmOptions, keyof LlmSamplingOptions>;

/**
 * Token usage reported by the provider. Mirrors the Vercel AI SDK
 * `LanguageModelUsage` shape so result.usage can be used interchangeably
 * with `generateText()` return values.
 *
 * Cache fields are populated only when the provider reports them (currently
 * Anthropic with prompt caching enabled). Absent when the provider does not
 * support caching or caching was not active for the call.
 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cached input tokens read from the provider's cache (e.g. Anthropic prompt caching). */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's cache for future calls. */
  cacheWriteTokens?: number;
}

/**
 * LLM result shape aligned with Vercel AI SDK generateText() return value.
 * Same property names (text, output, usage) so code and docs transfer directly.
 */
export interface LlmResult {
  /** Generated text (raw string from the model). */
  text: string;
  /** Parsed structured output when `output` schema was set and validation succeeded. */
  output?: unknown;
  /**
   * Raw reasoning text from the provider (Anthropic extended thinking,
   * OpenAI o1, etc.) when supplied. Most callers can ignore this; it is
   * useful for debugging, audit trails, and chain-of-thought displays.
   */
  reasoning?: string;
  /** Token usage for the last step. Same shape as AI SDK usage. */
  usage?: LlmUsage;
  /**
   * Reason the model loop terminated (`"stop"`, `"length"`, `"tool-calls"`,
   * etc.). Populated by both the sync (`generateText`) and streaming
   * (`streamText`) paths. The streaming path awaits the SDK's
   * `result.finishReason` Promise before resolving so callers always
   * see a normalised string value.
   */
  finishReason?: string;
  /**
   * Flat list of tool calls made during the loop, in invocation
   * order. Each entry pairs the model's call args with the handler's
   * return (or thrown error). Populated by both sync and streaming
   * paths; the agent layer surfaces these on `AgentResult.toolCalls`
   * for post-dispatch assertions.
   */
  toolCalls?: LlmToolCallSummary[];
  /**
   * Number of model steps the SDK consumed in this call. Mirrors
   * `result.steps.length` and is populated by both the sync and
   * streaming paths. The agent session uses this to track the shared
   * turn budget across `validate` retries: every retry's step count
   * is added to the running total and compared against `maxTurns`.
   */
  stepsCount?: number;
  /**
   * Conversation messages emitted during this call (assistant + tool
   * messages, in order; mirrors the SDK's `result.response.messages`).
   * The agent session uses this to assemble the messages array for a
   * `validate`-triggered retry: original user prompt + these response
   * messages + the corrective user message become the next call's
   * `prompt`.
   */
  responseMessages?: unknown[];
  /** Full generateText() result for advanced use (debugging, response metadata). */
  raw?: unknown;
}

/**
 * One tool invocation captured during an LLM dispatch. Mirrors the
 * shape of `AgentToolCallSummary` so the agent layer can re-export
 * it without re-mapping. Keep `unknown` types loose here; the agent
 * layer is the place to re-narrow if needed.
 */
export interface LlmToolCallSummary {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
}

/**
 * When an `output` schema S is provided to llm(), the result type narrows
 * `output` to `InferOutput<S>`. Used for type inference from
 * `llm(modelId, { output })` so body.output is typed downstream.
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
  // LM Studio (local; ids are whatever model you have loaded)
  | "lmstudio:qwen2.5-7b-instruct"
  | "lmstudio:llama-3.2-3b-instruct"
  | "lmstudio:phi-4"
  | "lmstudio:mistral-nemo-instruct-2407"
  // OpenRouter (top open-weight / frontier: GLM, Kimi, Qwen, DeepSeek)
  | "openrouter:z-ai/glm-5"
  | "openrouter:z-ai/glm-4.7"
  | "openrouter:moonshotai/kimi-k2-thinking"
  | "openrouter:qwen/qwen3.5-plus-02-15"
  | "openrouter:qwen/qwen3-next"
  | "openrouter:deepseek/deepseek-v3.2"
  | "openrouter:deepseek/deepseek-r1"
  | "openrouter:meta-llama/llama-3.3-70b-instruct"
  // Gemini (2026: 2.5 + 3.x)
  | "gemini:gemini-3.7-flash"
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
  /** Optional context-level default options (system, temperature, etc.). */
  defaultOptions?: Partial<LlmOptionsMerged>;
}
