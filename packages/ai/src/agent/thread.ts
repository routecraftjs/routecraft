import {
  rcError,
  stepStateFingerprint,
  type SuspensionCasResult,
  type SuspensionStore,
} from "@routecraft/routecraft";
import {
  contentPartsOf,
  parseStepState,
  type ThreadMessage,
} from "./suspension-state.ts";
// Registers AI1008, thrown from the integrity checks below.
import "../errors.ts";

/**
 * Editing the thread of a run that is parked, safely.
 *
 * The motivating caller is compaction: a long-running agent parks at an
 * approval, its thread has grown past what the model will accept, and the
 * only moment to shrink it is while it is still parked. Doing that touches
 * two things that are easy to get wrong, so both live here rather than at
 * the call site.
 *
 * The first is the thread's own integrity. A model provider rejects a
 * thread whose tool calls and tool results do not pair up, and a summariser
 * asked to shorten a conversation will happily drop half of a pair. A
 * broken thread written back to the store is not discovered at compaction
 * time: it is discovered when the approver clicks the link, by which point
 * the approval is spent and the run is unrecoverable.
 *
 * The second is the race. The store's compare-and-swap does the work
 * (see `replaceStepState`), and this module supplies its two arguments: the
 * fingerprint of the state the rewrite was based on, and a replacement that
 * has been checked first.
 */

/**
 * The tool-call and tool-result ids of one thread, in the order the model
 * emitted them.
 *
 * @internal
 */
interface ThreadPairing {
  readonly calls: string[];
  readonly results: string[];
}

/**
 * The tool-call ids one role contributes to a thread.
 *
 * Reads through `contentPartsOf`, which `suspension-state.ts` documents as
 * the single decoder for the SDK's known-but-external message shape, so an
 * SDK representation change is fixed there rather than here. The id policy
 * stays here, because it is this module's: an unpairable part is AI1008,
 * where the other walks tolerate one.
 */
function idsOf(
  messages: readonly ThreadMessage[],
  role: "assistant" | "tool",
  wanted: "tool-call" | "tool-result",
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of contentPartsOf(message, role) ?? []) {
      if (part === null || typeof part !== "object") continue;
      const typed = part as { type?: unknown; toolCallId?: unknown };
      if (typed.type !== wanted) continue;
      if (typeof typed.toolCallId !== "string" || typed.toolCallId === "") {
        throw rcError("AI1008", undefined, {
          message: `A ${wanted} part in the rewritten thread carries no toolCallId, so it can never be paired.`,
        });
      }
      ids.push(typed.toolCallId);
    }
  }
  return ids;
}

/**
 * Read the tool-call / tool-result ids out of a thread.
 *
 * `role: "assistant"` messages hold `{ type: "tool-call", toolCallId }`
 * parts, `role: "tool"` messages hold `{ type: "tool-result", toolCallId }`
 * parts. A part that is neither is not this function's business.
 */
function pairingOf(messages: readonly ThreadMessage[]): ThreadPairing {
  return {
    calls: idsOf(messages, "assistant", "tool-call"),
    results: idsOf(messages, "tool", "tool-result"),
  };
}

/**
 * The first tool-call id whose result appears before the call that produced
 * it, or `undefined` when every pair is in order.
 *
 * The set comparisons below prove a call and a result exist for each id; a
 * provider additionally reads the thread in order, so a summariser that
 * reordered messages produces a thread that passes the pairing check and is
 * still refused at dispatch.
 */
function firstResultBeforeItsCall(
  messages: readonly ThreadMessage[],
): string | undefined {
  const seenCalls = new Set<string>();
  for (const message of messages) {
    for (const id of idsOf([message], "assistant", "tool-call")) {
      seenCalls.add(id);
    }
    for (const id of idsOf([message], "tool", "tool-result")) {
      if (!seenCalls.has(id)) return id;
    }
  }
  return undefined;
}

/**
 * Refuse a rewritten thread a parked run could not be resumed from.
 *
 * The rules are the ones that make a resume possible at all, not a taste
 * check on the summary:
 *
 * - The thread is not empty. An empty thread resumes into a model call with
 *   nothing to answer.
 * - Every tool call has exactly one result, and every result has exactly
 *   one call. This is the pairing every provider enforces, and the one a
 *   summariser breaks by dropping a message it judged uninteresting.
 * - No tool-call id appears twice.
 * - The suspended call is still there. Its result slot is where the
 *   approver's answer lands, and a thread without it fails the revival with
 *   `AI1007` AFTER the approval has been spent.
 *
 * @param messages - The rewritten thread
 * @param suspendedToolCallId - The parked call the resume answers
 * @throws AI1008 when the thread cannot be resumed from
 */
export function assertResumableThread(
  messages: readonly ThreadMessage[],
  suspendedToolCallId: string,
): void {
  if (messages.length === 0) {
    throw rcError("AI1008", undefined, {
      message:
        "The rewritten thread is empty, so the resumed run would have no conversation to continue.",
    });
  }
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== "object" ||
      typeof message.role !== "string"
    ) {
      throw rcError("AI1008", undefined, {
        message:
          "The rewritten thread contains an entry that is not a { role, content } message.",
      });
    }
  }

  const { calls, results } = pairingOf(messages);
  const callSet = new Set(calls);
  if (callSet.size !== calls.length) {
    throw rcError("AI1008", undefined, {
      message:
        "The rewritten thread emits the same tool-call id more than once, so a result cannot be attributed to one call.",
    });
  }
  const resultSet = new Set(results);
  if (resultSet.size !== results.length) {
    throw rcError("AI1008", undefined, {
      message:
        "The rewritten thread records the same tool-result id more than once.",
    });
  }

  const misordered = firstResultBeforeItsCall(messages);
  if (misordered) {
    throw rcError("AI1008", undefined, {
      message: `The rewritten thread places the result for "${misordered}" before the call that produced it. A provider reads the thread in order, so a reordered pair is as unresumable as a missing one.`,
    });
  }

  const unanswered = calls.filter((id) => !resultSet.has(id));
  if (unanswered.length > 0) {
    throw rcError("AI1008", undefined, {
      message: `The rewritten thread has tool calls with no result: ${unanswered.join(", ")}. Drop a call and its result together, or keep both.`,
    });
  }
  const orphaned = results.filter((id) => !callSet.has(id));
  if (orphaned.length > 0) {
    throw rcError("AI1008", undefined, {
      message: `The rewritten thread has tool results with no matching call: ${orphaned.join(", ")}. Drop a result and its call together, or keep both.`,
    });
  }
  if (!callSet.has(suspendedToolCallId)) {
    throw rcError("AI1008", undefined, {
      message: `The rewritten thread no longer contains the suspended tool call "${suspendedToolCallId}", which is where the approver's answer lands on resume.`,
    });
  }
}

/**
 * Rewrite the message thread of a parked agent run, in place, without
 * disturbing anything else about the record.
 *
 * The rewrite is applied to the thread as it stands in the store, checked
 * with {@link assertResumableThread}, and written back through the store's
 * compare-and-swap. Losing that swap is an ordinary outcome, not an error:
 * a resume, a sweep, or another rewrite got there first, and the returned
 * record says which.
 *
 * Nothing but `messages` changes. `turnsUsed` in particular is left alone:
 * shrinking the conversation does not give the run its budget back.
 *
 * @param store - The suspension store holding the parked run
 * @param suspensionId - The parked run
 * @param rewrite - Given the stored thread, returns the replacement
 * @returns Whether this caller performed the replacement, and the record as
 *   it stands afterwards
 * @throws AI1007 when the stored step state is not an agent record
 * @throws AI1008 when the rewrite produced an unresumable thread
 */
export async function replaceParkedThread(
  store: SuspensionStore,
  suspensionId: string,
  rewrite: (
    messages: readonly ThreadMessage[],
  ) => readonly ThreadMessage[] | Promise<readonly ThreadMessage[]>,
): Promise<SuspensionCasResult> {
  const record = await store.get(suspensionId);
  if (!record) return { won: false, suspension: undefined };
  if (record.status !== "suspended") {
    // Reported without attempting the swap. The store would refuse it too,
    // but calling a rewrite (an LLM call, in the compaction case) on a run
    // that has already resumed is work with no possible outcome.
    return { won: false, suspension: record };
  }

  const state = parseStepState(record.stepState);
  // Taken before the rewrite runs. `parseStepState` hands back the object it
  // was given, so a rewrite that edits the thread in place (a splice is the
  // obvious way to drop old turns) would otherwise be fingerprinted after
  // its own edit, and the compare would ask whether nothing had changed
  // since it changed it.
  const expected = stepStateFingerprint(record.stepState);
  // A copy, because the rewrite is allowed to edit in place and a custom
  // store may have handed back its own record rather than a detached one.
  // Without this, a rewrite that then fails validation, or loses the swap,
  // would still have corrupted the parked thread.
  const messages = await rewrite(structuredClone(state.messages));
  assertResumableThread(messages, state.suspendedToolCallId);

  return store.replaceStepState(suspensionId, expected, { ...state, messages });
}
