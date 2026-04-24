import {
  rcError,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import type { LlmModelConfig, LlmPromptSource } from "./types.ts";
import { ADAPTER_LLM_PROVIDERS } from "./types.ts";

/** Parses a "providerId:modelName" id string into its parts. Throws when malformed. */
export function parseProviderModel(id: string): {
  providerId: string;
  modelName: string;
} {
  const colon = id.indexOf(":");
  if (colon < 1 || colon === id.length - 1) {
    throw new Error(
      `LLM model id must be "providerId:modelName" (e.g. ollama:lfm2.5-thinking). Got: "${id}"`,
    );
  }
  return {
    providerId: id.slice(0, colon),
    modelName: id.slice(colon + 1),
  };
}

/**
 * Resolves a provider config and model name from a model reference. The
 * reference can be either a "provider:model" string (resolved via the
 * llmPlugin store) or an inline `LlmModelConfig` (used directly, with the
 * model name taken from the config's `modelId` when set).
 */
export function resolveModel(
  model: string | LlmModelConfig,
  context: CraftContext | undefined,
): { config: LlmModelConfig; modelName: string } {
  if (typeof model !== "string") {
    const modelName = (model as { modelId?: string }).modelId ?? "";
    if (modelName.trim() === "") {
      throw rcError("RC5003", undefined, {
        message:
          `LLM model: inline LlmModelConfig for provider "${model.provider}" did not resolve to a model name. ` +
          `Either pass the model as a "providerId:modelName" string (e.g. "${model.provider}:<model>") ` +
          `or set "modelId" on the config. Providers "openai", "anthropic", and "gemini" do not carry ` +
          `a modelId field, so those must use the string form.`,
      });
    }
    return { config: model, modelName };
  }

  if (!context) {
    throw new Error(
      `LLM model id "${model}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so store "${ADAPTER_LLM_PROVIDERS.description}" can be read.`,
    );
  }

  const store = context.getStore(
    ADAPTER_LLM_PROVIDERS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, LlmModelConfig> | undefined;
  if (!store) {
    throw new Error(
      `LLM provider not found: no providers registered. Add llmPlugin({ providers: { ollama: { provider: "ollama" }, ... } }) to your config.`,
    );
  }

  const { providerId, modelName } = parseProviderModel(model);
  const config = store.get(providerId);
  if (!config) {
    throw new Error(
      `LLM provider "${providerId}" not found. Register it with llmPlugin({ providers: { "${providerId}": { provider, apiKey?, baseURL? } } }).`,
    );
  }
  return { config, modelName };
}

/** Resolves a prompt source (string or function) against an exchange. Empty source returns "". */
export function resolvePrompt(
  source: LlmPromptSource | undefined,
  exchange: Exchange<unknown>,
): string {
  if (source === undefined || source === "") return "";
  if (typeof source === "function") return source(exchange);
  return source;
}

/** Default user-prompt derivation: string body as-is, JSON for objects, String() otherwise. */
export function resolveUserPromptDefault(exchange: Exchange<unknown>): string {
  const body = exchange.body;
  if (typeof body === "string") return body;
  if (body === null || body === undefined) return "";
  if (typeof body === "object") return JSON.stringify(body);
  return String(body);
}
