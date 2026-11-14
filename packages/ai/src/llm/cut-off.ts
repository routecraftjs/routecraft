import { rcError } from "@routecraft/routecraft";
// Registers AI1020, thrown below.
import "../errors.ts";
import type { LlmResult } from "./types.ts";

/**
 * Finish reasons that mean the provider stopped the model, as opposed to the
 * model deciding it was done.
 */
const CUT_OFF_REASONS: ReadonlySet<string> = new Set([
  "length",
  "content-filter",
]);

/**
 * Refuse a model call the provider cut off before the model produced
 * anything: no text, no tool call and no structured output.
 *
 * Such a call is not an answer. Passed on as one it reads as a model that
 * chose to say nothing, and the usual cause is the output cap: thinking
 * tokens count against `maxTokens`, so a model can spend the whole cap
 * before it writes a word. A call that was cut off after producing something
 * is left alone, because a partial answer is still the author's to judge.
 *
 * @throws AI1020 when the call was cut off with nothing in it
 * @internal
 */
export function assertNotCutOffEmpty(result: LlmResult, model: string): void {
  const reason = result.finishReason;
  if (reason === undefined || !CUT_OFF_REASONS.has(reason)) return;
  if (result.text.trim() !== "") return;
  if (result.toolCalls !== undefined && result.toolCalls.length > 0) return;
  if (result.output !== undefined) return;
  const spent =
    result.usage?.outputTokens !== undefined
      ? ` after ${result.usage.outputTokens} output tokens`
      : "";
  throw rcError("AI1020", undefined, {
    message:
      reason === "length"
        ? `Model "${model}" hit its output limit${spent} before producing any text or tool call. Thinking tokens count against maxTokens: raise it, or lower reasoning.`
        : `Model "${model}" was stopped by the provider's content filter${spent} before producing any text or tool call.`,
  });
}
