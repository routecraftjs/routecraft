import type {
  LlmModelConfig,
  LlmOptionsMerged,
  LlmToolCallSummary,
  LlmUsage,
} from "../types.ts";

export interface CallLlmParams {
  config: LlmModelConfig;
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
  /**
   * User-side conversation. When a string, it is sent as a single
   * user prompt. When an array, it is forwarded directly to the SDK
   * as the `prompt` argument (Vercel AI SDK accepts
   * `string | Array<ModelMessage>` for `prompt`). The agent session
   * uses the array form to feed back the prior assistant + tool
   * messages plus a validator-corrective user message on a `validate`
   * retry, so the model sees the full history rather than a fresh
   * conversation.
   */
  user: string | unknown[];
  /** Optional structured output spec (from toAiOutputSpec). */
  output?: unknown;
  /**
   * Optional Vercel AI SDK tool map. When supplied the SDK runs the
   * tool-calling loop.
   */
  tools?: Record<string, unknown>;
  /**
   * Optional stop condition for the tool-calling loop.
   */
  stopWhen?: unknown;
  /**
   * Optional abort signal forwarded into `generateText` / `streamText`.
   */
  abortSignal?: AbortSignal;
}

/** Provider-level defaults so users can register models with minimal config (e.g. { provider: "ollama" }). */
export const PROVIDER_DEFAULTS = {
  ollama: {
    baseURL: "http://localhost:11434/api",
  },
  lmstudio: {
    baseURL: "http://localhost:1234/v1",
  },
} as const;

export function assertLanguageModelShape(
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

/** Pass through AI SDK usage into LlmUsage, including cache token details when present. */
export function toLlmUsage(u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?:
    | {
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | undefined;
}): LlmUsage {
  return {
    ...(u.inputTokens !== undefined && { inputTokens: u.inputTokens }),
    ...(u.outputTokens !== undefined && { outputTokens: u.outputTokens }),
    ...(u.totalTokens !== undefined && { totalTokens: u.totalTokens }),
    ...(u.inputTokenDetails?.cacheReadTokens !== undefined && {
      cacheReadTokens: u.inputTokenDetails.cacheReadTokens,
    }),
    ...(u.inputTokenDetails?.cacheWriteTokens !== undefined && {
      cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens,
    }),
  };
}

/**
 * Safely read structured output from generateText result. The AI SDK's result.output
 * is a getter that throws AI_NoOutputGeneratedError when the model didn't produce
 * valid structured output (e.g. empty, blocked, or unparseable). Catching here
 * allows returning without output so the adapter can try parsing result.text.
 */
export function getStructuredOutput(result: { output?: unknown }): unknown {
  try {
    if ("output" in result && result.output !== undefined) return result.output;
  } catch {
    // SDK getter threw (e.g. AI_NoOutputGeneratedError); leave output undefined.
  }
  return undefined;
}

/**
 * Defensive accessor for reasoning text. Vercel AI SDK exposes
 * `reasoningText` (concatenated string) when the provider returned
 * reasoning blocks (Anthropic extended thinking, OpenAI o1, etc.).
 */
export function readReasoning(result: unknown): string | undefined {
  const r = result as { reasoningText?: unknown };
  if (typeof r.reasoningText === "string" && r.reasoningText.length > 0) {
    return r.reasoningText;
  }
  return undefined;
}

/**
 * Walk an SDK result's `steps` array (sync or post-await) and
 * produce a flat list of `LlmToolCallSummary` entries pairing each
 * tool call with its result or error.
 */
export function collectToolCalls(result: unknown): LlmToolCallSummary[] {
  if (result === null || typeof result !== "object") return [];
  const steps = (result as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const out: LlmToolCallSummary[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue;
    const calls = (step as { toolCalls?: unknown }).toolCalls;
    const results = (step as { toolResults?: unknown }).toolResults;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call === null || typeof call !== "object") continue;
      const c = call as Record<string, unknown>;
      const toolCallId =
        typeof c["toolCallId"] === "string" ? c["toolCallId"] : "";
      const toolName = typeof c["toolName"] === "string" ? c["toolName"] : "";
      const input = c["input"] ?? c["args"];
      const summary: LlmToolCallSummary = { toolCallId, toolName, input };
      if (Array.isArray(results)) {
        const match = (results as Record<string, unknown>[]).find(
          (r) => r["toolCallId"] === toolCallId,
        );
        if (match) {
          if ("output" in match || "result" in match) {
            summary.output = match["output"] ?? match["result"];
          }
          if ("error" in match && match["error"] !== undefined) {
            summary.error = match["error"];
          }
        }
      }
      out.push(summary);
    }
  }
  return out;
}

/** Per-provider extras forwarded into `generateText` / `streamText`. */
export interface ProviderExtras {
  output?: unknown;
  tools?: Record<string, unknown>;
  stopWhen?: unknown;
  abortSignal?: AbortSignal;
}

export function buildExtras(
  params: Pick<CallLlmParams, "output" | "tools" | "stopWhen" | "abortSignal">,
): ProviderExtras {
  const out: ProviderExtras = {};
  if (params.output !== undefined) out.output = params.output;
  if (params.tools !== undefined && Object.keys(params.tools).length > 0) {
    out.tools = params.tools;
    if (params.stopWhen !== undefined) out.stopWhen = params.stopWhen;
  }
  if (params.abortSignal !== undefined) out.abortSignal = params.abortSignal;
  return out;
}

export function buildSdkParams(
  model: unknown,
  options: Pick<
    LlmOptionsMerged,
    | "temperature"
    | "maxTokens"
    | "topP"
    | "frequencyPenalty"
    | "presencePenalty"
  >,
  system: string,
  user: string | unknown[],
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
