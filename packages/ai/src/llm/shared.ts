import {
  rcError,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import type {
  LlmModelConfig,
  LlmPromptSource,
  LlmSamplingOptions,
  LlmSamplingOptionsMerged,
} from "./types.ts";
import { ADAPTER_LLM_PROVIDERS } from "./types.ts";

/**
 * Sampling defaults for every model call the framework makes, `llm()` and
 * `agent()` alike. One source: an agent and an llm step that name the same
 * model behave the same when neither says otherwise.
 *
 * @internal
 */
export const DEFAULT_TEMPERATURE = 0;

/** @internal See {@link DEFAULT_TEMPERATURE}. */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Every key of the sampling block, exhaustive by construction: the `satisfies`
 * fails to compile when a key is added to `LlmSamplingOptions` and not listed
 * here, and when a key listed here is not on it.
 *
 * The exhaustiveness is the point. Both paths from an authored option to the
 * provider call used to copy the block field by field, so an option that
 * typechecked could still be dropped on the floor by a copy written before it
 * existed. Everything that copies the block now walks this list.
 *
 * @internal
 */
export const SAMPLING_OPTION_KEYS = Object.keys({
  temperature: true,
  maxTokens: true,
  topP: true,
  frequencyPenalty: true,
  presencePenalty: true,
  reasoning: true,
  providerOptions: true,
} satisfies Record<keyof LlmSamplingOptions, true>) as Array<
  keyof LlmSamplingOptions
>;

/**
 * The sampling block an options object asks for, with the framework defaults
 * filling `temperature` and `maxTokens` when it does not. Keys the author left
 * unset stay absent so the provider's own default applies rather than a value
 * the framework invented.
 *
 * @internal
 */
export function resolveSampling(
  options: LlmSamplingOptions,
): LlmSamplingOptionsMerged {
  const out: LlmSamplingOptionsMerged = {
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  for (const key of SAMPLING_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

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
    // A custom provider carrying a concrete model instance needs no model name
    // (only the factory form consumes one), so it is exempt from the guard.
    const isCustomInstance =
      model.provider === "custom" &&
      typeof (model as { model?: unknown }).model !== "function";
    if (modelName.trim() === "" && !isCustomInstance) {
      throw rcError("RC5003", undefined, {
        message:
          `LLM model: inline LlmModelConfig for provider "${model.provider}" did not resolve to a model name. ` +
          `Either pass the model as a "providerId:modelName" string (e.g. "${model.provider}:<model>") ` +
          `or set "modelId" on the config.`,
      });
    }
    return { config: model, modelName };
  }

  if (!context) {
    throw new Error(
      `LLM model id "${model}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so store "${ADAPTER_LLM_PROVIDERS.description}" can be read.`,
    );
  }

  const store = context.getStore(ADAPTER_LLM_PROVIDERS);
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
