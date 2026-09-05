import {
  addUsage,
  type CallLlmParams,
} from "../../src/llm/providers/llm-utils.ts";
import type {
  LlmResult,
  LlmToolCallSummary,
  LlmUsage,
} from "../../src/llm/types.ts";

/**
 * One "model" step of a scripted dispatch: either a batch of tool calls the
 * fake model emits (their handlers really run, which is what the suspension
 * and cancellation tests are exercising), or a final text answer.
 */
export interface ScriptedTurn {
  toolCalls?: Array<{ toolName: string; input?: unknown }>;
  text?: string;
  usage?: LlmUsage;
}

/** A scripted stand-in for the providers barrel. */
export interface ScriptedLlm {
  callLlm: (params: CallLlmParams) => Promise<LlmResult>;
  /**
   * Aliases the non-streaming implementation: no deltas are ever emitted,
   * so a test that supplies an `onDelta` listener gets silence, not a
   * production bug. Script a streaming assertion elsewhere if one is needed.
   */
  streamLlm: (params: CallLlmParams) => Promise<LlmResult>;
  /** Every params object callLlm received, for assertions on prompt/messages. */
  calls: CallLlmParams[];
  /** Refill the script (consumed turn by turn across calls). */
  script: ScriptedTurn[];
  /** True once a call observed its abort signal fire. */
  sawAbort: () => boolean;
  /** Clear script, recorded calls, and the abort flag between tests. */
  reset: () => void;
}

interface VercelToolLike {
  execute: (
    input: unknown,
    opts: {
      toolCallId: string;
      abortSignal?: AbortSignal;
      messages: unknown[];
    },
  ) => Promise<unknown>;
}

/**
 * Emulate the Vercel AI SDK's `generateText` tool loop closely enough for
 * the agent session's contract tests, mirroring the real behaviour the
 * session depends on (per `.standards/testing.md` "mirror real behaviour"):
 *
 * - tools in a batch execute concurrently, each with a unique toolCallId;
 * - a handler throw becomes an `error-text` tool result fed back to the
 *   loop, not a loop failure;
 * - `response.messages` carries the assistant tool-call message and the
 *   tool message with `{ type: "tool-result", toolCallId, output }` parts,
 *   objects wrapped as `{ type: "json", value }`;
 * - `stopWhen` conditions (function or array) are evaluated after every
 *   step and stop the loop when any returns true;
 * - `onStep` is called after every step with the response messages so
 *   far, cloned, matching the SDK's cumulative `onStepFinish`;
 * - an aborted signal fails the call with an `AbortError`.
 */
export function scriptedLlm(script: ScriptedTurn[]): ScriptedLlm {
  const calls: CallLlmParams[] = [];
  let aborted = false;
  let idSequence = 0;

  const callLlm = async (params: CallLlmParams): Promise<LlmResult> => {
    calls.push(params);
    const responseMessages: unknown[] = [];
    const steps: unknown[] = [];
    const toolCalls: LlmToolCallSummary[] = [];
    let usage: LlmUsage | undefined;
    let text = "";

    while (true) {
      if (params.abortSignal?.aborted) {
        aborted = true;
        const err = new Error("scripted llm: aborted");
        err.name = "AbortError";
        throw err;
      }
      const turn = script.shift();
      if (!turn) throw new Error("scripted llm: script exhausted");
      usage = addUsage(usage, turn.usage);

      if (turn.toolCalls && turn.toolCalls.length > 0) {
        const batch = turn.toolCalls.map((call) => ({
          toolCallId: `tc-${++idSequence}`,
          toolName: call.toolName,
          input: call.input ?? {},
        }));
        responseMessages.push({
          role: "assistant",
          content: batch.map((c) => ({ type: "tool-call", ...c })),
        });
        interface ExecutionRecord {
          toolCallId: string;
          toolName: string;
          input: unknown;
          output?: unknown;
          error?: unknown;
        }
        const results: ExecutionRecord[] = await Promise.all(
          batch.map(async (c): Promise<ExecutionRecord> => {
            const tool = (params.tools ?? {})[c.toolName] as
              VercelToolLike | undefined;
            if (!tool) {
              return { ...c, error: new Error(`no tool "${c.toolName}"`) };
            }
            try {
              const opts: {
                toolCallId: string;
                abortSignal?: AbortSignal;
                messages: unknown[];
              } = { toolCallId: c.toolCallId, messages: [] };
              if (params.abortSignal) opts.abortSignal = params.abortSignal;
              const output = await tool.execute(c.input, opts);
              return { ...c, output };
            } catch (error) {
              return { ...c, error };
            }
          }),
        );
        responseMessages.push({
          role: "tool",
          content: results.map((r) => ({
            type: "tool-result",
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output:
              // Property presence, not value: a handler that throws
              // undefined is still a failed call.
              "error" in r
                ? {
                    type: "error-text",
                    value: String(
                      r.error instanceof Error ? r.error.message : r.error,
                    ),
                  }
                : { type: "json", value: r.output },
          })),
        });
        for (const r of results) {
          toolCalls.push({
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            input: r.input,
            ...("error" in r ? { error: r.error } : { output: r.output }),
          });
        }
        steps.push({ toolCalls: batch });
        await params.onStep?.({
          responseMessages: structuredClone(responseMessages),
        });
        if (await stopped(params.stopWhen, steps)) break;
        continue;
      }

      text = turn.text ?? "";
      responseMessages.push({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      steps.push({ toolCalls: [] });
      await params.onStep?.({
        responseMessages: structuredClone(responseMessages),
      });
      break;
    }

    const out: LlmResult = {
      text,
      raw: undefined,
      finishReason: "stop",
      stepsCount: steps.length,
      responseMessages,
    };
    if (usage) out.usage = usage;
    if (toolCalls.length > 0) out.toolCalls = toolCalls;
    return out;
  };

  return {
    callLlm,
    streamLlm: callLlm,
    calls,
    script,
    sawAbort: () => aborted,
    reset: () => {
      script.length = 0;
      calls.length = 0;
      aborted = false;
    },
  };
}

async function stopped(stopWhen: unknown, steps: unknown[]): Promise<boolean> {
  const conditions = Array.isArray(stopWhen)
    ? stopWhen
    : stopWhen !== undefined
      ? [stopWhen]
      : [];
  for (const condition of conditions) {
    if (typeof condition === "function" && (await condition({ steps }))) {
      return true;
    }
  }
  return false;
}
