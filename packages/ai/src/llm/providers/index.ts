import type {
  LlmModelConfig,
  LlmOptionsMerged,
  LlmResult,
  LlmUsage,
} from "../types.ts";

function throwProviderInstallError(pkg: string, provider: string): never {
  throw new Error(
    `The ${provider} LLM provider requires the "${pkg}" package. Install it with: pnpm add ${pkg}`,
  );
}

function isModuleNotFoundFor(error: unknown, pkg: string): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message ?? "";
  return (
    (msg.includes("ERR_MODULE_NOT_FOUND") ||
      msg.includes("Cannot find module") ||
      msg.includes("Cannot find package")) &&
    msg.includes(pkg)
  );
}

/** Provider-level defaults so users can register models with minimal config (e.g. { provider: "ollama" }). */
const PROVIDER_DEFAULTS = {
  ollama: {
    baseURL: "http://localhost:11434/api",
  },
} as const;

/** Pass through AI SDK usage so LlmUsage matches LanguageModelUsage (inputTokens/outputTokens). */
function toLlmUsage(u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): LlmUsage {
  return {
    ...(u.inputTokens !== undefined && { inputTokens: u.inputTokens }),
    ...(u.outputTokens !== undefined && { outputTokens: u.outputTokens }),
    ...(u.totalTokens !== undefined && { totalTokens: u.totalTokens }),
  };
}

/**
 * Safely read structured output from generateText result. The AI SDK's result.output
 * is a getter that throws AI_NoOutputGeneratedError when the model didn't produce
 * valid structured output (e.g. empty, blocked, or unparseable). Catching here
 * allows returning without output so the adapter can try parsing result.text.
 */
function getStructuredOutput(result: { output?: unknown }): unknown {
  try {
    if ("output" in result && result.output !== undefined) return result.output;
  } catch {
    // SDK getter threw (e.g. AI_NoOutputGeneratedError); leave output undefined.
  }
  return undefined;
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
  system: string;
  user: string;
  /** Optional structured output spec (from toAiOutputSpec). Enables provider-level JSON schema. */
  output?: unknown;
  /**
   * Optional Vercel AI SDK tool map. When supplied the SDK runs the
   * tool-calling loop: presents tools to the model, dispatches calls,
   * feeds results (and validation/guard errors) back, until the loop
   * terminates (a final text response or `stopWhen` fires).
   */
  tools?: Record<string, unknown>;
  /**
   * Optional stop condition for the tool-calling loop. Required when
   * `tools` is set; ignored otherwise. Built via `stepCountIs(n)` (or
   * any other Vercel AI SDK stop predicate).
   */
  stopWhen?: unknown;
}

/**
 * Per-provider extras forwarded into `generateText`. Centralised so
 * each provider builds the same shape and the typecast at the call
 * site stays narrow.
 *
 * @internal
 */
interface ProviderExtras {
  output?: unknown;
  tools?: Record<string, unknown>;
  stopWhen?: unknown;
}

function buildExtras(params: CallLlmParams): ProviderExtras {
  const out: ProviderExtras = {};
  if (params.output !== undefined) out.output = params.output;
  if (params.tools !== undefined && Object.keys(params.tools).length > 0) {
    out.tools = params.tools;
    if (params.stopWhen !== undefined) out.stopWhen = params.stopWhen;
  }
  return out;
}

/**
 * Dispatches to the appropriate provider and returns a normalized LlmResult.
 */
export async function callLlm(params: CallLlmParams): Promise<LlmResult> {
  const { config, modelId, options, system, user } = params;
  const extras = buildExtras(params);
  switch (config.provider) {
    case "openai":
      return callOpenAI(config, modelId, options, system, user, extras);
    case "anthropic":
      return callAnthropic(config, modelId, options, system, user, extras);
    case "gemini":
      return callGemini(config, modelId, options, system, user, extras);
    case "openrouter":
      return callOpenRouter(config, modelId, options, system, user, extras);
    case "ollama":
      return callOllama(config, modelId, options, system, user, extras);
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
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
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
  const openaiSettings: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseURL !== undefined) openaiSettings.baseURL = config.baseURL;
  const openai = createOpenAI(openaiSettings);
  const model = openai(modelId);
  return runGenerate(
    model as Parameters<typeof runGenerate>[0],
    options,
    system,
    user,
    extras,
  );
}

async function callAnthropic(
  config: import("../types.ts").LlmModelConfigAnthropic,
  modelId: string,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
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
  const model = anthropic(modelId);
  return runGenerate(
    model as Parameters<typeof runGenerate>[0],
    options,
    system,
    user,
    extras,
  );
}

async function callGemini(
  config: import("../types.ts").LlmModelConfigGemini,
  modelId: string,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
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
  const model = google(modelId);
  return runGenerate(
    model as Parameters<typeof runGenerate>[0],
    options,
    system,
    user,
    extras,
  );
}

async function callOpenRouter(
  config: import("../types.ts").LlmModelConfigOpenRouter,
  modelId: string,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
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
  return runGenerate(
    rawModel as Parameters<typeof runGenerate>[0],
    options,
    system,
    user,
    extras,
  );
}

async function callOllama(
  config: import("../types.ts").LlmModelConfigOllama,
  modelId: string,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
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
  return runGenerate(
    rawModel as Parameters<typeof runGenerate>[0],
    options,
    system,
    user,
    extras,
  );
}

/**
 * Shared `generateText` invocation. Each provider helper builds the
 * model and delegates here so the genParams shape, extras handling
 * (output / tools / stopWhen), and result normalisation (text /
 * output / reasoning / usage) live in one place.
 *
 * @internal
 */
async function runGenerate(
  model: unknown,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Promise<LlmResult> {
  const { generateText } = await import("ai");
  const genParams: Parameters<typeof generateText>[0] = {
    model: model as Parameters<typeof generateText>[0]["model"],
    prompt: user,
    ...(options.maxTokens !== undefined && {
      maxOutputTokens: options.maxTokens,
    }),
    temperature: options.temperature,
  };
  if (system) genParams.system = system;
  if (options.topP !== undefined) genParams.topP = options.topP;
  if (options.frequencyPenalty !== undefined)
    genParams.frequencyPenalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    genParams.presencePenalty = options.presencePenalty;
  const params = { ...genParams, ...extras };
  const result = await generateText(
    params as Parameters<typeof generateText>[0],
  );
  const out: LlmResult = { text: result.text ?? "", raw: result };
  if (result.usage) out.usage = toLlmUsage(result.usage);
  const parsed = getStructuredOutput(result as { output?: unknown });
  if (parsed !== undefined) out.output = parsed;
  const reasoning = readReasoning(result);
  if (reasoning) out.reasoning = reasoning;
  return out;
}

/**
 * Defensive accessor for reasoning text. Vercel AI SDK exposes
 * `reasoningText` (concatenated string) when the provider returned
 * reasoning blocks (Anthropic extended thinking, OpenAI o1, etc.).
 * Some SDK versions or providers may omit it; treat absence as
 * "no reasoning available."
 */
function readReasoning(result: unknown): string | undefined {
  const r = result as { reasoningText?: unknown };
  if (typeof r.reasoningText === "string" && r.reasoningText.length > 0) {
    return r.reasoningText;
  }
  return undefined;
}
