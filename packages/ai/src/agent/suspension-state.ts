import { rcError } from "@routecraft/routecraft";
import type { AgentSuspendOptions } from "./suspend.ts";
// Registers AI1007, thrown from the rehydration checks below.
import "../errors.ts";

/**
 * What the agent tier persists in the core suspension record's `stepState`
 * slot: the closure state of a tool loop parked mid-flight. The store never
 * interprets it; this module is the single owner of its shape.
 *
 * `messages` is the ModelMessage thread up to and including the suspended
 * batch, with the suspended call's placeholder result still in place (the
 * resume path swaps the real answer in by `suspendedToolCallId`). Only
 * resolved strings and plain JSON ever land here: the system prompt,
 * blocks, and tools are re-resolved live when the step re-runs.
 *
 * `turnsUsed` makes the `maxTurns` budget survive the park: a park is not a
 * fresh dispatch, and a reset would make park/resume cycling an
 * unbounded-budget loop.
 */
export interface AgentStepState {
  agentId: string;
  messages: unknown[];
  suspendedToolCallId: string;
  turnsUsed: number;
}

/**
 * One suspension signal collected by the tool bridge during a batch of tool
 * calls: which call raised it, and what it asked for.
 *
 * @internal
 */
export interface AgentSuspendSignalRecord {
  toolCallId: string;
  toolName: string;
  request: AgentSuspendOptions;
}

/**
 * The tool result the bridge records for a call that suspended. The model
 * only ever sees it after a resume, and only for a losing sibling (the
 * winner's placeholder is replaced by the real answer before the loop
 * continues), so it reads as a state description, not an instruction.
 *
 * @internal
 */
export const SUSPENDED_TOOL_PLACEHOLDER = {
  status: "suspended",
} as const;

/**
 * The tool result a LOSING suspend signal is rewritten to when a sibling in
 * the same batch already parked the run. Recorded as an error output so the
 * resumed model knows the tool did not run to completion and can retry it.
 *
 * @internal
 */
export const SIBLING_SUSPENDED_MESSAGE =
  "A sibling tool call in this batch already suspended the run. This call did not park; retry it after the resume if it is still needed.";

/**
 * Validate step state read back off a suspension record.
 *
 * The record crossed a process boundary and possibly a deploy, so nothing
 * about its shape is assumed: a malformed slot fails the revival with a
 * typed error instead of feeding garbage into a model call.
 *
 * @throws AI1007 when the value is not the shape the runtime writes
 *
 * @internal
 */
export function parseStepState(value: unknown): AgentStepState {
  const state = value as Partial<AgentStepState> | null | undefined;
  if (
    state === null ||
    typeof state !== "object" ||
    typeof state.agentId !== "string" ||
    !Array.isArray(state.messages) ||
    typeof state.suspendedToolCallId !== "string" ||
    typeof state.turnsUsed !== "number" ||
    !Number.isFinite(state.turnsUsed) ||
    state.turnsUsed < 0
  ) {
    throw rcError("AI1007", undefined, {
      message:
        "The resumed suspension's stepState is not the { agentId, messages, suspendedToolCallId, turnsUsed } record the agent runtime writes, so the tool loop cannot be re-entered.",
    });
  }
  return state as AgentStepState;
}

/**
 * A tool-result output slot, in the Vercel AI SDK's ModelMessage shape.
 *
 * @internal
 */
export interface ToolResultOutput {
  type: "json" | "error-text";
  value: unknown;
}

/**
 * Replace one tool call's recorded result in a ModelMessage thread,
 * copy-on-write along the touched path.
 *
 * The messages are treated as data of a known-but-external shape: a
 * `role: "tool"` message whose `content` array holds
 * `{ type: "tool-result", toolCallId, output }` parts. Anything else passes
 * through untouched, so a future SDK field survives the round trip.
 *
 * @param messages - The persisted thread
 * @param toolCallId - Which call's result to replace
 * @param output - The replacement output slot
 * @returns `{ messages, found }`: the (possibly new) thread and whether the
 *   call was found. The caller decides whether absence is an error; the
 *   resume path treats it as AI1007, the park path as a wiring bug.
 *
 * @internal
 */
export function replaceToolResultOutput(
  messages: unknown[],
  toolCallId: string,
  output: ToolResultOutput,
): { messages: unknown[]; found: boolean } {
  let found = false;
  const next = messages.map((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "tool" ||
      !Array.isArray((message as { content?: unknown }).content)
    ) {
      return message;
    }
    const content = (message as { content: unknown[] }).content;
    let touched = false;
    const nextContent = content.map((part) => {
      if (
        part === null ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "tool-result" ||
        (part as { toolCallId?: unknown }).toolCallId !== toolCallId
      ) {
        return part;
      }
      touched = true;
      found = true;
      return { ...(part as Record<string, unknown>), output };
    });
    return touched ? { ...(message as object), content: nextContent } : message;
  });
  return { messages: found ? next : messages, found };
}

/**
 * Pick the winning suspend signal of a batch: the one whose tool call the
 * model emitted FIRST, read from the assistant messages' tool-call order so
 * the choice is deterministic under parallel execution (completion order is
 * not). Falls back to collection order when no call is found in the thread,
 * which only happens if the SDK's message shape changes under us.
 *
 * @internal
 */
export function pickWinningSignal(
  signals: AgentSuspendSignalRecord[],
  messages: unknown[],
): AgentSuspendSignalRecord {
  const byId = new Map(signals.map((s) => [s.toolCallId, s]));
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "assistant" ||
      !Array.isArray((message as { content?: unknown }).content)
    ) {
      continue;
    }
    for (const part of (message as { content: unknown[] }).content) {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-call"
      ) {
        const id = (part as { toolCallId?: unknown }).toolCallId;
        if (typeof id === "string") {
          const hit = byId.get(id);
          if (hit) return hit;
        }
      }
    }
  }
  return signals[0]!;
}
