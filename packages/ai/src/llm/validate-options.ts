import type { LlmPluginOptions, LlmProviderType } from "./types.ts";

const PROVIDERS: LlmProviderType[] = [
  "openai",
  "anthropic",
  "openrouter",
  "ollama",
  "gemini",
];

function isProvider(s: string): s is LlmProviderType {
  return (PROVIDERS as string[]).includes(s);
}

/**
 * Validates LLM plugin options at apply time.
 * Key is the provider; value is options for that provider (no provider field).
 */
export function validateLlmPluginOptions(options: LlmPluginOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("llmPlugin: options must be an object");
  }
  if (!options.providers || typeof options.providers !== "object") {
    throw new TypeError(
      "llmPlugin: options.providers must be an object (record of provider id → options)",
    );
  }
  for (const [providerId, opts] of Object.entries(options.providers)) {
    if (opts === undefined) continue;
    if (!opts || typeof opts !== "object") {
      throw new TypeError(
        `llmPlugin: providers["${providerId}"] must be an object`,
      );
    }
    if (!isProvider(providerId)) {
      throw new TypeError(
        `llmPlugin: providers["${providerId}"] is not a supported provider. Supported: ${PROVIDERS.join(", ")}`,
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
          throw new TypeError(
            `llmPlugin: providers["${providerId}"].apiKey is required`,
          );
        }
        break;
      case "ollama":
        if (
          (opts as { baseURL?: string }).baseURL !== undefined &&
          typeof (opts as { baseURL?: string }).baseURL !== "string"
        ) {
          throw new TypeError(
            `llmPlugin: providers["${providerId}"].baseURL must be a string when provided`,
          );
        }
        if (
          (opts as { modelId?: string }).modelId !== undefined &&
          (typeof (opts as { modelId?: string }).modelId !== "string" ||
            !(opts as { modelId: string }).modelId.trim())
        ) {
          throw new TypeError(
            `llmPlugin: providers["${providerId}"].modelId must be a non-empty string when provided`,
          );
        }
        break;
    }
  }
  if (
    options.defaultOptions !== undefined &&
    (typeof options.defaultOptions !== "object" ||
      options.defaultOptions === null)
  ) {
    throw new TypeError(
      "llmPlugin: defaultOptions must be an object when provided",
    );
  }
}
