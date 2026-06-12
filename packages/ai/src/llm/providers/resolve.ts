import { loadOptionalPeer } from "@routecraft/routecraft";
import { assertLanguageModelShape, PROVIDER_DEFAULTS } from "./llm-utils.ts";
import type { LlmModelConfig } from "../types.ts";

/**
 * Resolve the AI SDK `LanguageModel` for a given provider config.
 * Single source of truth used by both the synchronous and streaming
 * dispatch paths so provider setup is not duplicated per dispatch mode.
 *
 * Provider SDKs are optional peer dependencies, loaded lazily through
 * `loadOptionalPeer` so a missing package surfaces as `RC5017` with an
 * install hint (see `.standards/ci-cd.md` § 6).
 */
export async function resolveLanguageModel(
  config: LlmModelConfig,
  modelId: string,
): Promise<unknown> {
  switch (config.provider) {
    case "openai":
      return resolveOpenAI(config, modelId);
    case "anthropic":
      return resolveAnthropic(config, modelId);
    case "gemini":
      return resolveGemini(config, modelId);
    case "openrouter":
      return resolveOpenRouter(config, modelId);
    case "ollama":
      return resolveOllama(config, modelId);
    case "lmstudio":
      return resolveLmStudio(config, modelId);
    case "custom":
      return resolveCustom(config, modelId);
    default: {
      const _: never = config;
      throw new Error(
        `LLM provider not implemented: ${(_ as LlmModelConfig).provider}`,
      );
    }
  }
}

/**
 * Build the `{ apiKey, baseURL? }` settings bag shared by the keyed cloud
 * providers (OpenAI, Anthropic, Gemini). `baseURL` is only set when
 * configured so the SDK's own resolution still applies when absent; when
 * configured, config beats ambient env vars such as `ANTHROPIC_BASE_URL`.
 *
 * @internal
 */
export function keyedProviderSettings(config: {
  apiKey: string;
  baseURL?: string;
}): { apiKey: string; baseURL?: string } {
  const settings: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseURL !== undefined) settings.baseURL = config.baseURL;
  return settings;
}

async function resolveOpenAI(
  config: import("../types.ts").LlmModelConfigOpenAI,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/openai"), {
    adapterName: "OpenAI LLM",
    packageName: "@ai-sdk/openai",
  })) as {
    createOpenAI: (s: {
      apiKey: string;
      baseURL?: string;
    }) => (m: string) => unknown;
  };
  const openai = mod.createOpenAI(keyedProviderSettings(config));
  return openai(modelId);
}

async function resolveAnthropic(
  config: import("../types.ts").LlmModelConfigAnthropic,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/anthropic"), {
    adapterName: "Anthropic LLM",
    packageName: "@ai-sdk/anthropic",
  })) as {
    createAnthropic: (s: {
      apiKey: string;
      baseURL?: string;
    }) => (m: string) => unknown;
  };
  const anthropic = mod.createAnthropic(keyedProviderSettings(config));
  return anthropic(modelId);
}

async function resolveGemini(
  config: import("../types.ts").LlmModelConfigGemini,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/google"), {
    adapterName: "Gemini LLM",
    packageName: "@ai-sdk/google",
  })) as {
    createGoogleGenerativeAI: (s: {
      apiKey: string;
      baseURL?: string;
    }) => (m: string) => unknown;
  };
  const google = mod.createGoogleGenerativeAI(keyedProviderSettings(config));
  return google(modelId);
}

async function resolveOpenRouter(
  config: import("../types.ts").LlmModelConfigOpenRouter,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(
    () => import("@openrouter/ai-sdk-provider"),
    {
      adapterName: "OpenRouter LLM",
      packageName: "@openrouter/ai-sdk-provider",
    },
  )) as {
    createOpenRouter: (s: { apiKey: string }) => {
      chat: (id: string) => unknown;
    };
  };
  const openrouter = mod.createOpenRouter({ apiKey: config.apiKey });
  const resolvedId = config.modelId ?? modelId;
  const rawModel = openrouter.chat(resolvedId);
  assertLanguageModelShape(rawModel, "OpenRouter", resolvedId);
  return rawModel;
}

async function resolveOllama(
  config: import("../types.ts").LlmModelConfigOllama,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("ollama-ai-provider-v2"), {
    adapterName: "Ollama LLM",
    packageName: "ollama-ai-provider-v2",
  })) as {
    createOllama: (s: { baseURL?: string }) => (name: string) => unknown;
  };
  const ollama = mod.createOllama({
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.ollama.baseURL,
  });
  const name = config.modelId ?? modelId;
  const rawModel = ollama(name);
  assertLanguageModelShape(rawModel, "Ollama", name);
  return rawModel;
}

async function resolveLmStudio(
  config: import("../types.ts").LlmModelConfigLmStudio,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(
    () => import("@ai-sdk/openai-compatible"),
    { adapterName: "LM Studio LLM", packageName: "@ai-sdk/openai-compatible" },
  )) as {
    createOpenAICompatible: (s: {
      name: string;
      baseURL: string;
      apiKey?: string;
      includeUsage?: boolean;
    }) => (id: string) => unknown;
  };
  // LM Studio serves an OpenAI-compatible chat-completions API. We use Vercel's
  // dedicated openai-compatible provider (not @ai-sdk/openai) so the adapter is
  // not tied to OpenAI-specific behaviour such as the Responses API. The
  // provider's default model is the chat-completions model, and `includeUsage`
  // makes LM Studio report token usage on streaming responses too.
  const settings: {
    name: string;
    baseURL: string;
    apiKey?: string;
    includeUsage: boolean;
  } = {
    name: "lmstudio",
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.lmstudio.baseURL,
    includeUsage: true,
  };
  // Only send an Authorization header when a key is configured; LM Studio
  // ignores auth, so we do not invent a placeholder bearer token.
  if (config.apiKey !== undefined) settings.apiKey = config.apiKey;
  const lmstudio = mod.createOpenAICompatible(settings);
  const name = config.modelId ?? modelId;
  const rawModel = lmstudio(name);
  assertLanguageModelShape(rawModel, "LM Studio", name);
  return rawModel;
}

function resolveCustom(
  config: import("../types.ts").LlmModelConfigCustom,
  modelId: string,
): unknown {
  const { model } = config;
  const resolved =
    typeof model === "function"
      ? (model as (id: string) => unknown)(modelId)
      : model;
  assertLanguageModelShape(resolved, "Custom", modelId || "(custom)");
  return resolved;
}
