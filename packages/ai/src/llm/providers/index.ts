import type {
  LlmModelConfig,
  LlmOptionsMerged,
  LlmResult,
  LlmUsage,
} from "../types.ts";

/** Provider-level defaults so users can register models with minimal config (e.g. { provider: "ollama" }). */
const PROVIDER_DEFAULTS = {
  ollama: {
    baseURL: "http://localhost:11434/api",
  },
} as const;

/** Map AI SDK LanguageModelUsage (inputTokens/outputTokens) to our LlmUsage (promptTokens/completionTokens). */
function mapUsage(u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): LlmUsage {
  return {
    ...(u.inputTokens !== undefined && { promptTokens: u.inputTokens }),
    ...(u.outputTokens !== undefined && { completionTokens: u.outputTokens }),
    ...(u.totalTokens !== undefined && { totalTokens: u.totalTokens }),
  };
}

/**
 * Runtime check that a provider-returned value has the minimal LanguageModel shape
 * required by the AI SDK generateText (doGenerate, doStream). Throws a descriptive
 * error if validation fails so we avoid silent type assertions.
 */
function assertLanguageModelShape(
  model: unknown,
  providerName: string,
  modelId: string,
): void {
  if (model === null || typeof model !== "object") {
    throw new Error(
      `[${providerName}] Invalid model: expected an object, got ${typeof model}. Model id: ${modelId}`,
    );
  }
  const m = model as Record<string, unknown>;
  if (typeof m["doGenerate"] !== "function") {
    throw new Error(
      `[${providerName}] Invalid model: missing or invalid doGenerate method. Model id: ${modelId}. ` +
        "Ensure the provider returns an AI SDK-compatible language model.",
    );
  }
  if (typeof m["doStream"] !== "function") {
    throw new Error(
      `[${providerName}] Invalid model: missing or invalid doStream method. Model id: ${modelId}. ` +
        "Ensure the provider returns an AI SDK-compatible language model.",
    );
  }
}

export interface CallLlmParams {
  config: LlmModelConfig;
  /** Model id to use for the request (for OpenRouter may be config.modelId ?? registeredId). */
  modelId: string;
  options: Pick<
    LlmOptionsMerged,
    | "temperature"
    | "maxTokens"
    | "topP"
    | "frequencyPenalty"
    | "presencePenalty"
  >;
  systemPrompt: string;
  userPrompt: string;
  /** Optional structured output spec (from toAiOutputSpec). Enables provider-level JSON schema. */
  output?: unknown;
}

/**
 * Dispatches to the appropriate provider and returns a normalized LlmResult.
 */
export async function callLlm(params: CallLlmParams): Promise<LlmResult> {
  const { config, modelId, options, systemPrompt, userPrompt, output } = params;
  switch (config.provider) {
    case "openai":
      return callOpenAI(
        config,
        modelId,
        options,
        systemPrompt,
        userPrompt,
        output,
      );
    case "anthropic":
      return callAnthropic(
        config,
        modelId,
        options,
        systemPrompt,
        userPrompt,
        output,
      );
    case "gemini":
      return callGemini(
        config,
        modelId,
        options,
        systemPrompt,
        userPrompt,
        output,
      );
    case "openrouter":
      return callOpenRouter(
        config,
        modelId,
        options,
        systemPrompt,
        userPrompt,
        output,
      );
    case "ollama":
      return callOllama(
        config,
        modelId,
        options,
        systemPrompt,
        userPrompt,
        output,
      );
    default: {
      const _: never = config;
      throw new Error(
        `LLM provider not implemented: ${(_ as LlmModelConfig).provider}`,
      );
    }
  }
}

async function callOpenAI(
  config: import("../types.ts").LlmModelConfigOpenAI,
  modelId: string,
  options: CallLlmParams["options"],
  systemPrompt: string,
  userPrompt: string,
  output: CallLlmParams["output"],
): Promise<LlmResult> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { generateText } = await import("ai");
  const openaiSettings: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseURL !== undefined) openaiSettings.baseURL = config.baseURL;
  const openai = createOpenAI(openaiSettings);
  const model = openai(modelId);
  const genParams: Parameters<typeof generateText>[0] = {
    model,
    prompt: userPrompt,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (systemPrompt) genParams.system = systemPrompt;
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = output !== undefined ? { ...genParams, output } : genParams;
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { content: result.text ?? "", raw: result };
  if (result.usage) out.usage = mapUsage(result.usage);
  if ("output" in result && result.output !== undefined)
    out.value = result.output;
  return out;
}

async function callAnthropic(
  config: import("../types.ts").LlmModelConfigAnthropic,
  modelId: string,
  options: CallLlmParams["options"],
  systemPrompt: string,
  userPrompt: string,
  output: CallLlmParams["output"],
): Promise<LlmResult> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const { generateText } = await import("ai");
  const anthropic = createAnthropic({ apiKey: config.apiKey });
  const model = anthropic(modelId);
  const genParams: Parameters<typeof generateText>[0] = {
    model,
    prompt: userPrompt,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (systemPrompt) genParams.system = systemPrompt;
  // Same option keys as callOpenAI; SDK passes through. Anthropic supports topP;
  // frequencyPenalty/presencePenalty may be unsupported (SDK may warn).
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = output !== undefined ? { ...genParams, output } : genParams;
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { content: result.text ?? "", raw: result };
  if (result.usage) out.usage = mapUsage(result.usage);
  if ("output" in result && result.output !== undefined)
    out.value = result.output;
  return out;
}

async function callGemini(
  config: import("../types.ts").LlmModelConfigGemini,
  modelId: string,
  options: CallLlmParams["options"],
  systemPrompt: string,
  userPrompt: string,
  output: CallLlmParams["output"],
): Promise<LlmResult> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const { generateText } = await import("ai");
  const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
  const model = google(modelId);
  const genParams: Parameters<typeof generateText>[0] = {
    model,
    prompt: userPrompt,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (systemPrompt) genParams.system = systemPrompt;
  // Same option keys as callOpenAI; SDK passes through. Gemini may not support
  // all (e.g. frequencyPenalty/presencePenalty); check result.warnings if needed.
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = output !== undefined ? { ...genParams, output } : genParams;
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { content: result.text ?? "", raw: result };
  if (result.usage) out.usage = mapUsage(result.usage);
  if ("output" in result && result.output !== undefined)
    out.value = result.output;
  return out;
}

async function callOpenRouter(
  config: import("../types.ts").LlmModelConfigOpenRouter,
  modelId: string,
  options: CallLlmParams["options"],
  systemPrompt: string,
  userPrompt: string,
  output: CallLlmParams["output"],
): Promise<LlmResult> {
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  const { generateText } = await import("ai");
  const openrouter = createOpenRouter({ apiKey: config.apiKey });
  const resolvedId = config.modelId ?? modelId;
  const rawModel = openrouter.chat(resolvedId);
  assertLanguageModelShape(rawModel, "OpenRouter", resolvedId);
  const model = rawModel as Parameters<typeof generateText>[0]["model"];
  const genParams: Parameters<typeof generateText>[0] = {
    model,
    prompt: userPrompt,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (systemPrompt) genParams.system = systemPrompt;
  // Same option keys as callOpenAI. OpenRouter is OpenAI-compatible; typically supports all.
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = output !== undefined ? { ...genParams, output } : genParams;
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { content: result.text ?? "", raw: result };
  if (result.usage) out.usage = mapUsage(result.usage);
  if ("output" in result && result.output !== undefined)
    out.value = result.output;
  return out;
}

async function callOllama(
  config: import("../types.ts").LlmModelConfigOllama,
  modelId: string,
  options: CallLlmParams["options"],
  systemPrompt: string,
  userPrompt: string,
  output: CallLlmParams["output"],
): Promise<LlmResult> {
  const { createOllama } = await import("ollama-ai-provider-v2");
  const { generateText } = await import("ai");
  const ollama = createOllama({
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.ollama.baseURL,
  });
  const name = config.modelId ?? modelId;
  const rawModel = ollama(name);
  assertLanguageModelShape(rawModel, "Ollama", name);
  const model = rawModel as Parameters<typeof generateText>[0]["model"];
  const genParams: Parameters<typeof generateText>[0] = {
    model,
    prompt: userPrompt,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (systemPrompt) genParams.system = systemPrompt;
  // Same option keys as callOpenAI. Ollama supports top_p; frequencyPenalty/presencePenalty
  // may be unsupported (SDK may warn).
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = output !== undefined ? { ...genParams, output } : genParams;
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { content: result.text ?? "", raw: result };
  if (result.usage) out.usage = mapUsage(result.usage);
  if ("output" in result && result.output !== undefined)
    out.value = result.output;
  return out;
}
