import { describe, expect, test } from "bun:test";
import {
  MemorySuspensionStore,
  stepStateFingerprint,
  type NewSuspension,
} from "@routecraft/routecraft";
import {
  assertResumableThread,
  replaceParkedThread,
} from "../src/agent/thread.ts";
import type { ThreadMessage } from "../src/agent/suspension-state.ts";

/**
 * A minimal parked thread: one tool call, its placeholder result, and the
 * user turn that caused it. Matches the ModelMessage shape the agent tier
 * persists, which is the shape the checks decode.
 */
function thread(toolCallId = "call-1"): ThreadMessage[] {
  return [
    { role: "user", content: "approve the payout" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "request-approval" },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          output: { type: "json", value: { status: "suspended" } },
        },
      ],
    },
  ];
}

function parked(
  overrides: Partial<NewSuspension> = {},
  messages: ThreadMessage[] = thread(),
): NewSuspension {
  return {
    id: "sus-1",
    routeId: "approvals",
    position: 2,
    continuationHash: "c".repeat(64),
    actionFingerprint: "f".repeat(64),
    exchange: { body: {}, headers: { "routecraft.route": "approvals" } },
    schema: { hash: "e".repeat(64) },
    stepState: {
      agentId: "aria",
      messages,
      suspendedToolCallId: "call-1",
      turnsUsed: 3,
    },
    suspendedAt: new Date("2026-08-27T09:00:00.000Z"),
    ...overrides,
  };
}

describe("assertResumableThread", () => {
  /**
   * @case A well-formed thread with the suspended call intact passes
   * @preconditions One tool call, its result, and the suspended id naming that call
   * @expectedResult No throw, so an honest compaction is not blocked by the guard
   */
  test("accepts a paired thread that keeps the suspended call", () => {
    expect(() => assertResumableThread(thread(), "call-1")).not.toThrow();
  });

  /**
   * @case An empty thread is refused
   * @preconditions A rewrite that returned nothing at all
   * @expectedResult AI1008, because the resumed run would have no conversation to continue
   */
  test("refuses an empty thread", () => {
    expect(() => assertResumableThread([], "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });

  /**
   * @case A tool call whose result was dropped is refused
   * @preconditions The tool message removed, the assistant tool-call kept
   * @expectedResult AI1008 naming the unanswered call, rather than a provider rejecting the thread on resume
   */
  test("refuses a tool call left without its result", () => {
    const broken = thread().filter((message) => message.role !== "tool");
    expect(() => assertResumableThread(broken, "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });

  /**
   * @case A tool result whose call was dropped is refused
   * @preconditions The assistant message removed, the tool result kept
   * @expectedResult AI1008 naming the orphaned result
   */
  test("refuses a tool result left without its call", () => {
    const broken = thread().filter((message) => message.role !== "assistant");
    expect(() => assertResumableThread(broken, "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });

  /**
   * @case A duplicated tool-call id is refused
   * @preconditions Two assistant tool-call parts sharing one id
   * @expectedResult AI1008, because a result could not be attributed to one of them
   */
  test("refuses a duplicated tool-call id", () => {
    const broken = thread();
    broken.splice(2, 0, {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "x" }],
    });
    expect(() => assertResumableThread(broken, "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });

  /**
   * @case A result placed before its call is refused
   * @preconditions Every id still pairs, but the tool message precedes the assistant message that produced it
   * @expectedResult AI1008, because a provider reads the thread in order and a set comparison alone would pass this
   */
  test("refuses a tool result that precedes its call", () => {
    const [user, assistant, tool] = thread() as [
      ThreadMessage,
      ThreadMessage,
      ThreadMessage,
    ];
    expect(() =>
      assertResumableThread([user, tool, assistant], "call-1"),
    ).toThrow(expect.objectContaining({ rc: "AI1008" }));
  });

  /**
   * @case A thread that dropped the suspended call is refused
   * @preconditions A well-formed thread for a different call id
   * @expectedResult AI1008 at compaction time, rather than AI1007 on resume after the approval is spent
   */
  test("refuses a thread that no longer holds the suspended call", () => {
    expect(() => assertResumableThread(thread("call-2"), "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });

  /**
   * @case A tool-call part with no id is refused
   * @preconditions An assistant part of type tool-call carrying no toolCallId
   * @expectedResult AI1008, because such a part can never be paired
   */
  test("refuses a tool-call part with no id", () => {
    const broken: ThreadMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolName: "x" }] },
    ];
    expect(() => assertResumableThread(broken, "call-1")).toThrow(
      expect.objectContaining({ rc: "AI1008" }),
    );
  });
});

describe("replaceParkedThread", () => {
  /**
   * @case A compaction of a parked run replaces only the thread
   * @preconditions A suspended record holding an agent step state
   * @expectedResult The swap is won, messages are the rewritten ones, and turnsUsed is untouched so shrinking the conversation does not refund the budget
   */
  test("replaces the thread and leaves the rest of the state alone", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());

    const shorter = thread().slice(1);
    const result = await replaceParkedThread(store, "sus-1", () => shorter);

    expect(result.won).toBe(true);
    const state = result.suspension?.stepState as {
      messages: ThreadMessage[];
      turnsUsed: number;
      agentId: string;
    };
    expect(state.messages).toHaveLength(2);
    expect(state.turnsUsed).toBe(3);
    expect(state.agentId).toBe("aria");
  });

  /**
   * @case A rewrite that breaks the thread never reaches the store
   * @preconditions A parked record and a rewrite that drops the tool result
   * @expectedResult AI1008, and the stored thread is exactly what it was, so a failed compaction costs nothing
   */
  test("refuses a broken rewrite without touching the record", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());

    await expect(
      replaceParkedThread(store, "sus-1", (messages) =>
        messages.filter((message) => message.role !== "tool"),
      ),
    ).rejects.toMatchObject({ rc: "AI1008" });

    const after = (await store.get("sus-1"))?.stepState as {
      messages: ThreadMessage[];
    };
    expect(after.messages).toHaveLength(3);
  });

  /**
   * @case A run that already resumed is not rewritten
   * @preconditions The record was resumed between the read and the compaction
   * @expectedResult won: false with the resumed record, and the rewrite is never invoked, so no model call is spent on work with no possible outcome
   */
  test("does not rewrite a run that already resumed", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());
    await store.markResumed("sus-1", { at: new Date() });

    let invoked = false;
    const result = await replaceParkedThread(store, "sus-1", (messages) => {
      invoked = true;
      return messages;
    });

    expect(result.won).toBe(false);
    expect(result.suspension?.status).toBe("resumed");
    expect(invoked).toBe(false);
  });

  /**
   * @case A compaction based on a stale read loses to one that already landed
   * @preconditions Two replacements built from the same fingerprint, the second standing in for a caller that read before the first wrote
   * @expectedResult The second loses the compare and the first one's thread stands, rather than the second silently discarding it
   *
   *   The second call goes through the store rather than the helper on
   *   purpose: `replaceParkedThread` takes its own read, so two calls to it
   *   are two independent compactions and cannot hold the same read. The
   *   fingerprint is what protects a caller that did, and this is where it
   *   is proven.
   */
  test("refuses a compaction built on a stale read", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());
    const before = (await store.get("sus-1"))?.stepState;

    const first = await replaceParkedThread(store, "sus-1", (messages) =>
      messages.slice(1),
    );
    const second = await store.replaceStepState(
      "sus-1",
      stepStateFingerprint(before),
      {
        agentId: "aria",
        messages: [],
        suspendedToolCallId: "call-1",
        turnsUsed: 3,
      },
    );

    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    expect(
      (second.suspension?.stepState as { messages: ThreadMessage[] }).messages,
    ).toHaveLength(2);
  });

  /**
   * @case A rewrite that edits the thread in place still wins the swap
   * @preconditions The rewrite mutates the array it was handed, which is the stored object, rather than returning a new one
   * @expectedResult The compare is against the state the rewrite was based on, so the swap wins instead of losing to the rewrite's own edit
   */
  test("compares against the pre-rewrite state, not the rewritten one", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());

    const result = await replaceParkedThread(store, "sus-1", (messages) => {
      (messages as ThreadMessage[]).splice(0, 1);
      return messages;
    });

    expect(result.won).toBe(true);
    expect(
      (result.suspension?.stepState as { messages: ThreadMessage[] }).messages,
    ).toHaveLength(2);
  });

  /**
   * @case A rewrite that mutates and then fails validation leaves the record intact
   * @preconditions The rewrite empties the array it was handed in place, which AI1008 then refuses
   * @expectedResult The stored thread is untouched, so a failed compaction costs nothing even against a store that hands back its own record
   */
  test("keeps the stored thread when a mutating rewrite is refused", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked());

    await expect(
      replaceParkedThread(store, "sus-1", (messages) => {
        (messages as ThreadMessage[]).length = 0;
        return messages;
      }),
    ).rejects.toMatchObject({ rc: "AI1008" });

    const after = (await store.get("sus-1"))?.stepState as {
      messages: ThreadMessage[];
    };
    expect(after.messages).toHaveLength(3);
  });

  /**
   * @case An unknown suspension reports a loss
   * @preconditions An empty store
   * @expectedResult won: false with no record, matching the store's own contract
   */
  test("reports a loss for an unknown suspension", async () => {
    const store = new MemorySuspensionStore();
    const result = await replaceParkedThread(store, "nope", (m) => m);
    expect(result).toEqual({ won: false, suspension: undefined });
  });

  /**
   * @case Step state that is not an agent record is refused
   * @preconditions A parked record whose stepState was written by something else
   * @expectedResult AI1007 from the shared rehydration parser, rather than a rewrite over a shape nobody owns
   */
  test("refuses step state that is not an agent record", async () => {
    const store = new MemorySuspensionStore();
    await store.create(parked({ stepState: { note: "not an agent" } }));

    await expect(
      replaceParkedThread(store, "sus-1", (m) => m),
    ).rejects.toMatchObject({ rc: "AI1007" });
  });
});
