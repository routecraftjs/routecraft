import { logger as frameworkLogger } from "@routecraft/routecraft";
import type { AgentDeltaListener } from "../../agent/events.ts";
import { normalizeStreamDelta } from "../../agent/events.ts";
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
  /**
   * Optional abort signal forwarded into `generateText`. When the
   * signal aborts mid-call, the SDK throws an AbortError and any
   * in-flight tool handlers receive the same signal via their
   * `FnHandlerContext.abortSignal`.
   *
   * Thread the route's signal here (`getExchangeRoute(exchange)?.signal`)
   * so an in-flight agent dispatch is cancelled when the route or
   * context shuts down.
   */
  abortSignal?: AbortSignal;
}

/**
 * Per-provider extras forwarded into `generateText` / `streamText`.
 * Centralised so each path builds the same shape and the typecast at
 * the call site stays narrow.
 *
 * @internal
 */
interface ProviderExtras {
  output?: unknown;
  tools?: Record<string, unknown>;
  stopWhen?: unknown;
  abortSignal?: AbortSignal;
}

function buildExtras(params: CallLlmParams): ProviderExtras {
  const out: ProviderExtras = {};
  if (params.output !== undefined) out.output = params.output;
  if (params.tools !== undefined && Object.keys(params.tools).length > 0) {
    out.tools = params.tools;
    if (params.stopWhen !== undefined) out.stopWhen = params.stopWhen;
  }
  if (params.abortSignal !== undefined) out.abortSignal = params.abortSignal;
  return out;
}

/**
 * Dispatch via Vercel AI SDK `generateText` and return a normalised
 * {@link LlmResult}. Resolves the language model for the configured
 * provider, then delegates to the shared {@link runGenerate} helper.
 */
export async function callLlm(params: CallLlmParams): Promise<LlmResult> {
  const { config, modelId, options, system, user } = params;
  const model = await resolveLanguageModel(config, modelId);
  return runGenerate(model, options, system, user, buildExtras(params));
}

/**
 * Streaming counterpart to {@link callLlm}. Resolves the language model
 * for the configured provider, calls Vercel's `streamText`, forwards
 * each normalised token-level delta to `onDelta`, and finally returns
 * the consolidated {@link LlmResult} once the stream drains.
 *
 * Used by the agent destination when the user supplies
 * `AgentOptions.onDelta`. Exposed at the LLM-provider layer so the
 * provider plumbing (model resolution, option mapping, reasoning
 * extraction) stays in one place.
 */
export async function streamLlm(
  params: CallLlmParams & { onDelta: AgentDeltaListener },
): Promise<LlmResult> {
  const { config, modelId, options, system, user, onDelta } = params;
  const model = await resolveLanguageModel(config, modelId);
  return runStreamGenerate(
    model,
    options,
    system,
    user,
    buildExtras(params),
    onDelta,
  );
}

/**
 * Resolve the AI SDK `LanguageModel` for a given provider config.
 * Single source of truth used by both the synchronous (`callLlm` →
 * `runGenerate`) and streaming (`streamLlm` → `runStreamGenerate`)
 * paths so provider setup is not duplicated per dispatch mode.
 *
 * @internal
 */
async function resolveLanguageModel(
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

/**
 * Build the common `generateText` / `streamText` argument shape from
 * the merged options + system/user prompts + extras. Both the
 * synchronous and streaming paths feed this into their respective SDK
 * call so option mapping (temperature, max tokens, etc.) lives in one
 * place.
 *
 * @internal
 */
function buildSdkParams(
  model: unknown,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model,
    prompt: user,
    temperature: options.temperature,
  };
  if (options.maxTokens !== undefined)
    params["maxOutputTokens"] = options.maxTokens;
  if (system) params["system"] = system;
  if (options.topP !== undefined) params["topP"] = options.topP;
  if (options.frequencyPenalty !== undefined) {
    params["frequencyPenalty"] = options.frequencyPenalty;
  }
  if (options.presencePenalty !== undefined) {
    params["presencePenalty"] = options.presencePenalty;
  }
  return { ...params, ...extras };
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
  const params = buildSdkParams(model, options, system, user, extras);
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
 * Shared `streamText` invocation. Iterates the SDK's `fullStream`,
 * forwards each token-level delta to `onDelta`, then awaits the
 * consolidated values (text, usage, reasoning, optional structured
 * output) once the stream drains.
 *
 * Listener errors are caught and logged; they do not abort the
 * dispatch. Stream errors propagate out of `await result.text`, so
 * the dispatch fails normally; coarse decision events (tool calls,
 * finish) are emitted on the context bus by the agent session, not
 * here.
 *
 * @internal
 */
async function runStreamGenerate(
  model: unknown,
  options: CallLlmParams["options"],
  system: string,
  user: string,
  extras: ProviderExtras,
  onDelta: AgentDeltaListener,
): Promise<LlmResult> {
  const { streamText } = await import("ai");
  const params = buildSdkParams(model, options, system, user, extras);
  const result = streamText(params as Parameters<typeof streamText>[0]);

  for await (const part of result.fullStream) {
    const delta = normalizeStreamDelta(part);
    if (delta === null) continue;
    try {
      await onDelta(delta);
    } catch (err) {
      frameworkLogger.warn(
        { err },
        "agent.onDelta listener threw; ignoring and continuing stream",
      );
    }
  }

  // Drain consolidated values. `result.text` rejects with the same
  // error that surfaced through fullStream, so failures propagate
  // through this await.
  const text = await result.text;
  const out: LlmResult = { text: text ?? "", raw: result };
  const usage = await safeAwait<{
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  }>(result.usage);
  if (usage) out.usage = toLlmUsage(usage);
  const reasoning = await safeAwait<string | undefined>(
    (result as { reasoningText?: PromiseLike<string | undefined> })
      .reasoningText,
  );
  if (typeof reasoning === "string" && reasoning.length > 0) {
    out.reasoning = reasoning;
  }
  const structured = await safeAwait<unknown>(
    (result as { output?: PromiseLike<unknown> }).output,
  );
  if (structured !== undefined) out.output = structured;
  return out;
}

/**
 * Await a value that may be a `PromiseLike<T>` (the AI SDK uses
 * `PromiseLike` for stream consolidation accessors) and swallow
 * rejections, returning `undefined` instead. Used to read optional
 * accessors (usage, reasoning, structured output) where absence is
 * not an error.
 *
 * Rejections are logged at debug level so a real provider regression
 * (SDK shape change, transport error on the optional accessor itself)
 * leaves a breadcrumb without surfacing as a user-visible warning.
 */
async function safeAwait<T>(
  value: T | PromiseLike<T> | undefined,
): Promise<T | undefined> {
  if (value === undefined) return undefined;
  try {
    return await value;
  } catch (err) {
    frameworkLogger.debug(
      { err },
      "llm.streamLlm: optional accessor rejected; treating as absent",
    );
    return undefined;
  }
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
