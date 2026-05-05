import type { LlmResult } from "../types.ts";
import {
  buildExtras,
  buildSdkParams,
  collectToolCalls,
  getStructuredOutput,
  readReasoning,
  toLlmUsage,
  type CallLlmParams,
  type ProviderExtras,
} from "./llm-utils.ts";
import { resolveLanguageModel } from "./resolve.ts";
import { streamLlm as _streamLlm } from "./stream-llm.ts";
import type { AgentDeltaListener } from "../../agent/events.ts";

export type { CallLlmParams } from "./llm-utils.ts";

/**
 * Wrapper exported from the barrel so that `agent-bus-events.bun.test.ts`
 * can mock this barrel without bun 1.3.11 propagating the mock through the
 * syntactic re-export chain into `stream-llm.ts` itself.
 * `stream-llm.bun.test.ts` imports directly from `stream-llm.ts` and must
 * get the real implementation; a syntactic re-export here would cause bun to
 * conflate the two modules in the process-global mock registry.
 */
export async function streamLlm(
  params: CallLlmParams & { onDelta: AgentDeltaListener },
): Promise<LlmResult> {
  return _streamLlm(params);
}

/**
 * Dispatch via Vercel AI SDK `generateText` and return a normalised
 * `LlmResult`. Resolves the language model for the configured
 * provider, then delegates to the shared `runGenerate` helper.
 */
export async function callLlm(params: CallLlmParams): Promise<LlmResult> {
  const { config, modelId, options, system, user } = params;
  const model = await resolveLanguageModel(config, modelId);
  return runGenerate(model, options, system, user, buildExtras(params));
}

async function runGenerate(
  model: unknown,
  options: CallLlmParams["options"],
  system: string,
  user: string | unknown[],
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
  const finishReason = (result as { finishReason?: unknown }).finishReason;
  if (typeof finishReason === "string") out.finishReason = finishReason;
  const toolCalls = collectToolCalls(result);
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const steps = (result as { steps?: unknown }).steps;
  if (Array.isArray(steps)) out.stepsCount = steps.length;
  const responseMessages = (result as { response?: { messages?: unknown } })
    .response?.messages;
  if (Array.isArray(responseMessages)) out.responseMessages = responseMessages;
  return out;
}
