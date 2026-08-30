import type {
  LlmModelConfig,
  LlmProviderType,
  LlmSamplingOptionsMerged,
  LlmToolCallSummary,
  LlmUsage,
} from "../types.ts";
import { mergeProviderOptions, reasoningProviderOptions } from "./reasoning.ts";

export interface CallLlmParams {
  config: LlmModelConfig;
  modelId: string;
  /**
   * The whole sampling block, not a subset of it. A `Pick` here was one of the
   * two places a new option could typecheck and reach nothing.
   */
  options: LlmSamplingOptionsMerged;
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

/**
 * Sum token usage across the model calls of one dispatch, over every field
 * `LlmUsage` declares (cache tokens included). A field absent on both sides
 * stays absent, so a provider that never reports it does not fabricate a 0.
 *
 * @internal
 */
export function addUsage(
  total: LlmUsage | undefined,
  step: LlmUsage | undefined,
): LlmUsage | undefined {
  if (!step) return total;
  if (!total) return { ...step };
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const fields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const;
  const out: Record<string, number> = {};
  for (const field of fields) {
    const value = sum(total[field], step[field]);
    if (value !== undefined) out[field] = value;
  }
  return out as LlmUsage;
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

/**
 * Everything one dispatch hands the SDK. A named bag rather than a positional
 * list because the first slot is an opaque model handle and several of the
 * rest are strings, so a shuffled argument would not reliably be a type error.
 */
export interface SdkParamsInput {
  /** Resolved language model handle; opaque to the framework. */
  model: unknown;
  /**
   * Needed because the reasoning mapping is per provider and the resolved
   * model handle carries no provider identity by the time it gets here.
   */
  provider: LlmProviderType;
  options: LlmSamplingOptionsMerged;
  system: string;
  user: string | unknown[];
  extras: ProviderExtras;
}

/**
 * Assemble the arguments for `generateText` / `streamText`. The one place
 * where an authored option becomes an SDK parameter, for both the sync and
 * streaming paths, so `reasoning` is mapped here and the authored
 * `providerOptions` folded over the result.
 */
export function buildSdkParams({
  model,
  provider,
  options,
  system,
  user,
  extras,
}: SdkParamsInput): Record<string, unknown> {
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
  const providerOptions = mergeProviderOptions(
    options.reasoning === undefined
      ? undefined
      : reasoningProviderOptions(provider, options.reasoning),
    options.providerOptions,
  );
  if (providerOptions !== undefined) {
    params["providerOptions"] = providerOptions;
  }
  return { ...params, ...extras };
}
