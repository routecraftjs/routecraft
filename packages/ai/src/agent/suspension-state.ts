import { rcError } from "@routecraft/routecraft";
import type { LlmUsage } from "../llm/types.ts";
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
  readonly agentId: string;
  readonly messages: readonly ThreadMessage[];
  readonly suspendedToolCallId: string;
  readonly turnsUsed: number;
  /**
   * Token spend accumulated before the park, when any model call reported
   * one. Travels with `turnsUsed` for the same reason: a cancelled resumed
   * run must report the WHOLE run's spend, not just the slice after the
   * resume.
   */
  readonly usage?: LlmUsage;
}

/**
 * One message of the persisted model thread. The SDK owns the full
 * ModelMessage shape; this is the minimal structural slice the agent tier
 * reads and writes, so the producers ({@link AgentStepState.messages}, the
 * resume splice) and the consumers stay compile-time linked while unknown
 * SDK fields pass through untouched.
 */
export interface ThreadMessage {
  readonly role: string;
  readonly content?: unknown;
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
  const state = value as
    { [K in keyof AgentStepState]?: unknown } | null | undefined;
  if (
    state === null ||
    typeof state !== "object" ||
    typeof state.agentId !== "string" ||
    !Array.isArray(state.messages) ||
    !state.messages.every(
      (m: unknown) =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as { role?: unknown }).role === "string",
    ) ||
    typeof state.suspendedToolCallId !== "string" ||
    typeof state.turnsUsed !== "number" ||
    // A safe integer, not merely finite: a fractional or astronomically
    // large persisted value would corrupt the remaining-budget arithmetic.
    !Number.isSafeInteger(state.turnsUsed) ||
    state.turnsUsed < 0 ||
    (state.usage !== undefined &&
      (state.usage === null ||
        typeof state.usage !== "object" ||
        Array.isArray(state.usage)))
  ) {
    throw rcError("AI1007", undefined, {
      message:
        "The resumed suspension's stepState is not the { agentId, messages, suspendedToolCallId, turnsUsed, usage? } record the agent runtime writes, so the tool loop cannot be re-entered.",
    });
  }
  return state as AgentStepState;
}

/**
 * Turn a persisted `stepState` back into the session input a re-entrant
 * dispatch resumes from: validate the record, check it was parked by the
 * agent this route now dispatches, and splice the approver's answer into
 * the suspended call's tool result.
 *
 * Owns the rehydration policy in one testable place, next to the state
 * shape it interprets; the enricher only decides WHEN to rehydrate (a
 * resume state is present) and what identity to check against.
 *
 * @param raw - The value read off the exchange's resume slot
 * @param agentIdentity - The identity the dispatching route resolves today
 *   (agent name, or route id for an inline agent), `undefined` for a
 *   synthetic dispatch with no identity
 * @param answer - The validated-or-raw resume result to deliver as the
 *   suspended call's tool output
 * @returns The thread with the answer in place, and the turns already spent
 * @throws AI1007 when the state is malformed, was parked by a different
 *   agent, or its thread no longer contains the suspended call
 *
 * @internal
 */
export function rehydrateSession(
  raw: unknown,
  agentIdentity: string | undefined,
  answer: unknown,
): {
  messages: readonly ThreadMessage[];
  turnsUsed: number;
  usage?: LlmUsage;
} {
  const state = parseStepState(raw);
  if (agentIdentity === undefined || state.agentId !== agentIdentity) {
    // The registered options behind a by-name agent are NOT covered by
    // the continuation hash (only step definitions are), so the name is
    // the one identity the record can pin. A mismatch means the route
    // was rebound to a different agent under the parked exchange.
    throw rcError("AI1007", undefined, {
      message: `This suspension was parked by agent "${state.agentId}", but the resumed route now dispatches ${
        agentIdentity === undefined
          ? "an agent with no identity (synthetic dispatch)"
          : `"${agentIdentity}"`
      }. Restore the original agent binding, or treat the parked work as lost and re-ask.`,
    });
  }
  const swapped = replaceToolResultOutput(
    state.messages,
    state.suspendedToolCallId,
    // Strictly a tool-result payload, never merged anywhere else: the
    // answer skipped expect validation at revival (no live schema
    // exists for a re-entrant site), so the model treats it like any
    // other untrusted tool output.
    { type: "json", value: answer },
  );
  if (!swapped.found) {
    throw rcError("AI1007", undefined, {
      message: `The resumed suspension's persisted thread does not contain the suspended tool call "${state.suspendedToolCallId}", so the answer has nowhere to land.`,
    });
  }
  return {
    messages: swapped.messages,
    turnsUsed: state.turnsUsed,
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
  };
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
  messages: readonly ThreadMessage[],
  toolCallId: string,
  output: ToolResultOutput,
): { messages: readonly ThreadMessage[]; found: boolean } {
  let found = false;
  const next = messages.map((message) => {
    const content = contentPartsOf(message, "tool");
    if (!content) return message;
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
    return touched ? { ...message, content: nextContent } : message;
  });
  return { messages: found ? next : messages, found };
}

/**
 * The content parts of a thread message of the given role, or `undefined`
 * when it is not one. The single decoder for the SDK's known-but-external
 * message shape, so an SDK representation change is fixed in one place
 * rather than drifting between the two walks below.
 *
 * @internal
 */
function contentPartsOf(
  message: ThreadMessage,
  role: "tool" | "assistant",
): unknown[] | undefined {
  if (message === null || typeof message !== "object") return undefined;
  return message.role === role && Array.isArray(message.content)
    ? message.content
    : undefined;
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
  messages: readonly ThreadMessage[],
): AgentSuspendSignalRecord {
  const byId = new Map(signals.map((s) => [s.toolCallId, s]));
  for (const message of messages) {
    const content = contentPartsOf(message, "assistant");
    if (!content) continue;
    for (const part of content) {
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
