import { logger as frameworkLogger } from "@routecraft/routecraft";
import type { AgentDeltaListener } from "../../agent/events.ts";
import { normalizeStreamDelta } from "../../agent/events.ts";
import type { LlmResult } from "../types.ts";
import {
  buildExtras,
  buildSdkParams,
  collectToolCalls,
  toLlmUsage,
  type CallLlmParams,
  type ProviderExtras,
} from "./llm-utils.ts";
import { resolveLanguageModel } from "./resolve.ts";

/**
 * Streaming counterpart to `callLlm`. Resolves the language model
 * for the configured provider, calls Vercel's `streamText`, forwards
 * each normalised token-level delta to `onDelta`, and finally returns
 * the consolidated `LlmResult` once the stream drains.
 *
 * Listener errors are caught and logged; they do not abort the
 * dispatch. Stream errors propagate out of `await result.text`.
 *
 * Exported from its own module so `stream-llm.bun.test.ts` can import
 * it directly without conflicting with `agent-bus-events.bun.test.ts`'s
 * `mock.module("../llm/providers/index.ts", ...)`. Bun 1.3.11 shares
 * the module registry across all files in a `bun test` run, so the two
 * test files must mock non-overlapping paths.
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
 * Shared `streamText` invocation. Iterates the SDK's `fullStream`,
 * forwards each token-level delta to `onDelta`, then awaits the
 * consolidated values once the stream drains.
 *
 * Listener errors are caught and logged; they do not abort the dispatch.
 */
export async function runStreamGenerate(
  model: unknown,
  options: CallLlmParams["options"],
  system: string,
  user: string | unknown[],
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
  const finishReason = await safeAwait<string | undefined>(
    (result as { finishReason?: PromiseLike<string | undefined> }).finishReason,
  );
  if (typeof finishReason === "string") out.finishReason = finishReason;
  const steps = await safeAwait<unknown>(
    (result as { steps?: PromiseLike<unknown> }).steps,
  );
  const toolCalls = collectToolCalls({ steps });
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  if (Array.isArray(steps)) out.stepsCount = steps.length;
  const response = await safeAwait<{ messages?: unknown }>(
    (result as { response?: PromiseLike<{ messages?: unknown }> }).response,
  );
  if (response && Array.isArray(response.messages)) {
    out.responseMessages = response.messages;
  }
  return out;
}

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
