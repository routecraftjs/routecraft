import {
  assertLanguageModelShape,
  isModuleNotFoundFor,
  PROVIDER_DEFAULTS,
  throwProviderInstallError,
} from "./llm-utils.ts";
import type { LlmModelConfig } from "../types.ts";

/**
 * Resolve the AI SDK `LanguageModel` for a given provider config.
 * Single source of truth used by both the synchronous and streaming
 * dispatch paths so provider setup is not duplicated per dispatch mode.
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
    default: {
      const _: never = config;
      throw new Error(
        `LLM provider not implemented: ${(_ as LlmModelConfig).provider}`,
      );
    }
  }
}

async function resolveOpenAI(
  config: import("../types.ts").LlmModelConfigOpenAI,
  modelId: string,
): Promise<unknown> {
  let createOpenAI: (s: {
    apiKey: string;
    baseURL?: string;
  }) => (m: string) => unknown;
  try {
    const mod = await import("@ai-sdk/openai");
    createOpenAI = mod.createOpenAI as typeof createOpenAI;
  } catch (error) {
    if (isModuleNotFoundFor(error, "@ai-sdk/openai")) {
      throwProviderInstallError("@ai-sdk/openai", "OpenAI");
    }
    throw error;
  }
  const settings: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseURL !== undefined) settings.baseURL = config.baseURL;
  const openai = createOpenAI(settings);
  return openai(modelId);
}

async function resolveAnthropic(
  config: import("../types.ts").LlmModelConfigAnthropic,
  modelId: string,
): Promise<unknown> {
  let createAnthropic: (s: { apiKey: string }) => (m: string) => unknown;
  try {
    const mod = await import("@ai-sdk/anthropic");
    createAnthropic = mod.createAnthropic as typeof createAnthropic;
  } catch (error) {
    if (isModuleNotFoundFor(error, "@ai-sdk/anthropic")) {
      throwProviderInstallError("@ai-sdk/anthropic", "Anthropic");
    }
    throw error;
  }
  const anthropic = createAnthropic({ apiKey: config.apiKey });
  return anthropic(modelId);
}

async function resolveGemini(
  config: import("../types.ts").LlmModelConfigGemini,
  modelId: string,
): Promise<unknown> {
  let createGoogleGenerativeAI: (s: {
    apiKey: string;
  }) => (m: string) => unknown;
  try {
    const mod = await import("@ai-sdk/google");
    createGoogleGenerativeAI =
      mod.createGoogleGenerativeAI as typeof createGoogleGenerativeAI;
  } catch (error) {
    if (isModuleNotFoundFor(error, "@ai-sdk/google")) {
      throwProviderInstallError("@ai-sdk/google", "Gemini");
    }
    throw error;
  }
  const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
  return google(modelId);
}

async function resolveOpenRouter(
  config: import("../types.ts").LlmModelConfigOpenRouter,
  modelId: string,
): Promise<unknown> {
  let createOpenRouter: (s: { apiKey: string }) => {
    chat: (id: string) => unknown;
  };
  try {
    const mod = await import("@openrouter/ai-sdk-provider");
    createOpenRouter = mod.createOpenRouter as typeof createOpenRouter;
  } catch (error) {
    if (isModuleNotFoundFor(error, "@openrouter/ai-sdk-provider")) {
      throwProviderInstallError("@openrouter/ai-sdk-provider", "OpenRouter");
    }
    throw error;
  }
  const openrouter = createOpenRouter({ apiKey: config.apiKey });
  const resolvedId = config.modelId ?? modelId;
  const rawModel = openrouter.chat(resolvedId);
  assertLanguageModelShape(rawModel, "OpenRouter", resolvedId);
  return rawModel;
}

async function resolveOllama(
  config: import("../types.ts").LlmModelConfigOllama,
  modelId: string,
): Promise<unknown> {
  let createOllama: (s: { baseURL?: string }) => (name: string) => unknown;
  try {
    const mod = await import("ollama-ai-provider-v2");
    createOllama = mod.createOllama as typeof createOllama;
  } catch (error) {
    if (isModuleNotFoundFor(error, "ollama-ai-provider-v2")) {
      throwProviderInstallError("ollama-ai-provider-v2", "Ollama");
    }
    throw error;
  }
  const ollama = createOllama({
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.ollama.baseURL,
  });
  const name = config.modelId ?? modelId;
  const rawModel = ollama(name);
  assertLanguageModelShape(rawModel, "Ollama", name);
  return rawModel;
}
