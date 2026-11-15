import { invalidOption } from "../shared/invalid-option.ts";
import { assertLanguageModelShape } from "./providers/llm-utils.ts";
import type { LlmPluginOptions, LlmProviderType } from "./types.ts";

const PROVIDERS: LlmProviderType[] = [
  "openai",
  "anthropic",
  "openrouter",
  "ollama",
  "gemini",
  "lmstudio",
  "custom",
];

function isProvider(s: string): s is LlmProviderType {
  return (PROVIDERS as string[]).includes(s);
}

/**
 * Validates LLM plugin options at apply time.
 * Key is the provider; value is options for that provider (no provider field).
 * @internal
 */
export function validateLlmPluginOptions(options: LlmPluginOptions): void {
  if (!options || typeof options !== "object") {
    throw invalidOption(
      `llmPlugin: options must be an object; got ${options === null ? "null" : typeof options}`,
      "Call llmPlugin({ providers: { ... } }).",
    );
  }
  if (!options.providers || typeof options.providers !== "object") {
    throw invalidOption(
      "llmPlugin: options.providers must be an object (record of provider id → options)",
      "Set `providers` to an object keyed by provider id, for example { anthropic: { apiKey } }.",
    );
  }
  for (const [providerId, opts] of Object.entries(options.providers)) {
    if (opts === undefined) continue;
    if (!opts || typeof opts !== "object") {
      throw invalidOption(
        `llmPlugin: providers["${providerId}"] must be an object`,
        "Give the provider an options object, or remove the key.",
      );
    }
    if (!isProvider(providerId)) {
      throw invalidOption(
        `llmPlugin: providers["${providerId}"] is not a supported provider. Supported: ${PROVIDERS.join(", ")}`,
        'Use one of the supported ids, or register the model under "custom".',
      );
    }
    switch (providerId) {
      case "openai":
      case "anthropic":
      case "openrouter":
      case "gemini":
        if (
          typeof (opts as { apiKey?: string }).apiKey !== "string" ||
          !(opts as { apiKey: string }).apiKey.trim()
        ) {
          throw invalidOption(
            `llmPlugin: providers["${providerId}"].apiKey is required`,
            "Set `apiKey` to the provider's key. When it comes from an environment variable, check that the variable is set.",
          );
        }
        // openrouter has no baseURL option; the other keyed providers do.
        if (
          providerId !== "openrouter" &&
          (opts as { baseURL?: string }).baseURL !== undefined &&
          typeof (opts as { baseURL?: string }).baseURL !== "string"
        ) {
          throw invalidOption(
            `llmPlugin: providers["${providerId}"].baseURL must be a string when provided`,
            "Set `baseURL` to the endpoint URL, or leave it out for the default.",
          );
        }
        break;
      case "ollama":
      case "lmstudio":
        if (
          (opts as { baseURL?: string }).baseURL !== undefined &&
          typeof (opts as { baseURL?: string }).baseURL !== "string"
        ) {
          throw invalidOption(
            `llmPlugin: providers["${providerId}"].baseURL must be a string when provided`,
            "Set `baseURL` to the endpoint URL, or leave it out for the default.",
          );
        }
        if (
          (opts as { modelId?: string }).modelId !== undefined &&
          (typeof (opts as { modelId?: string }).modelId !== "string" ||
            !(opts as { modelId: string }).modelId.trim())
        ) {
          throw invalidOption(
            `llmPlugin: providers["${providerId}"].modelId must be a non-empty string when provided`,
            "Set `modelId` to the model's name, or leave it out.",
          );
        }
        if (
          providerId === "lmstudio" &&
          (opts as { apiKey?: string }).apiKey !== undefined &&
          typeof (opts as { apiKey?: string }).apiKey !== "string"
        ) {
          throw invalidOption(
            `llmPlugin: providers["lmstudio"].apiKey must be a string when provided`,
            "Set `apiKey` to a string, or leave it out.",
          );
        }
        break;
      case "custom": {
        const model = (opts as { model?: unknown }).model;
        // A factory is only invoked at dispatch, so its return shape cannot be
        // checked eagerly; a concrete instance can, so assert it now and fail
        // at plugin apply rather than at first dispatch.
        if (typeof model === "function") break;
        if (model === null || typeof model !== "object") {
          throw invalidOption(
            `llmPlugin: providers["custom"].model must be an AI SDK language model or a factory function`,
            "Pass the model an AI SDK provider returns, or a function that returns one.",
          );
        }
        try {
          assertLanguageModelShape(model, "custom", "(custom)");
        } catch (cause) {
          throw invalidOption(
            `llmPlugin: providers["custom"].model is not an AI SDK language model: ${cause instanceof Error ? cause.message : String(cause)}`,
            "Pass the model an AI SDK provider returns, or a function that returns one.",
            cause,
          );
        }
        break;
      }
    }
  }
  if (
    options.defaultOptions !== undefined &&
    (typeof options.defaultOptions !== "object" ||
      options.defaultOptions === null)
  ) {
    throw invalidOption(
      "llmPlugin: defaultOptions must be an object when provided",
      "Set `defaultOptions` to an object of call options, or leave it out.",
    );
  }
}
