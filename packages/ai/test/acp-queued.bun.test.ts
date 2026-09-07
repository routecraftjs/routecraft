/**
 * A message sent while a turn is running is answered under that message.
 *
 * `session/update` carries no prompt id: the editor attributes whatever
 * streams to whichever `session/prompt` it has open. So the request that
 * queued a message has to stay open until the turn answering it has
 * streamed, and only then return. Every case here drives a real editor
 * client over a real socket, holds a turn in a tool, and sends more while
 * it is held.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { agentPlugin, tools, type FnHandlerContext } from "../src/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** A tool the test holds open, so a turn stays running until released. */
let release: (() => void) | undefined;
let entered = 0;
const slowFn = {
  description: "Waits until the test releases it",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) =>
    new Promise<string>((resolve, reject) => {
      entered += 1;
      const abort = (): void => {
        const err = new Error("slow tool aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
      release = () => resolve("released");
    }),
};

const echoFn = {
  description: "Echoes what it was given",
  input: z.object({ what: z.string() }),
  handler: (input: unknown) =>
    Promise.resolve(`echo:${(input as { what: string }).what}`),
};

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["slow", "echo"]),
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEntry(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (entered < count && Date.now() < deadline) await sleep(5);
  if (entered < count) throw new Error(`slow tool entry ${count} never came`);
}

/** The text of every agent message chunk in `entries`, in arrival order. */
function chunksIn(
  entries: ReadonlyArray<{ update: unknown; at: number }>,
): Array<{ text: string; at: number }> {
  return entries.flatMap((entry) => {
    const update = entry.update as {
      sessionUpdate: string;
      content?: { text?: string };
    };
    return update.sessionUpdate === "agent_message_chunk"
      ? [{ text: update.content?.text ?? "", at: entry.at }]
      : [];
  });
}

describe("a prompt sent while a turn is running", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
    release = undefined;
    entered = 0;
  });

  afterEach(async () => {
    release?.();
    if (h) await h.t.stop();
    h = undefined;
  });

  async function boot(): Promise<AcpHarness> {
    return acpHarness({
      agents: AGENT,
      plugins: [agentPlugin({ functions: { slow: slowFn, echo: echoFn } })],
    });
  }

  /**
   * @case A message sent while a turn runs is answered to its own request, with nothing further sent
   * @preconditions Prompt A held in a tool; prompt B arrives while A is held; A is released; the turn that answers B streams its reply
   * @expectedResult B's own request returns end_turn only after B's answer has streamed, A's request saw its own answer, the model was called exactly twice (no third prompt), and the second call carried B's text
   */
  test("the queued message's own request completes with its answer", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "A done" },
      { deltas: [{ text: "3" }, { text: "22" }], text: "322" },
    );

    const outcome = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const a = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await waitForEntry(1);

      const bSentAt = Date.now();
      const b = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "echo 322" }],
      });
      // B is pending while A holds: nothing has been answered for it.
      await sleep(50);
      expect(chunksIn(h!.seen).map((c) => c.text)).toEqual([]);

      release!();
      const aResponse = await a;
      const bResponse = await b;
      const bDoneAt = Date.now();
      session.dispose();
      return { aResponse, bResponse, bSentAt, bDoneAt };
    });

    expect(outcome.aResponse.stopReason).toBe("end_turn");
    expect(outcome.bResponse.stopReason).toBe("end_turn");
    const chunks = chunksIn(h.seen);
    expect(chunks.map((c) => c.text)).toEqual(["A done", "3", "22"]);
    // B's answer was on the wire while B's request was still open.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.at).toBeGreaterThanOrEqual(outcome.bSentAt);
      expect(chunk.at).toBeLessThanOrEqual(outcome.bDoneAt);
    }
    // Two model calls: A's, and the one boundary turn that answered B.
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls[1]?.user)).toContain("echo 322");
  });

  /**
   * @case Several messages sent while a turn runs are answered together, and every request ends after the one reply
   * @preconditions Prompt A held in a tool; B then C arrive while A is held; A is released; the turn that answers them does not stream
   * @expectedResult One boundary turn consumed both messages, its reply reached the editor exactly once, and both B and C returned end_turn after it was on the wire, in order
   */
  test("messages queued together get one reply and every request waits for it", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "A done" },
      { text: "both answered" },
    );

    const outcome = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const a = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await waitForEntry(1);

      const settled: string[] = [];
      const b = agent
        .request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "B" }],
        })
        .then((response) => {
          settled.push("b");
          return { response, at: Date.now() };
        });
      const c = agent
        .request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "C" }],
        })
        .then((response) => {
          settled.push("c");
          return { response, at: Date.now() };
        });
      await sleep(50);

      release!();
      await a;
      const [bDone, cDone] = await Promise.all([b, c]);
      session.dispose();
      return { bDone, cDone, settled };
    });

    expect(outcome.bDone.response.stopReason).toBe("end_turn");
    expect(outcome.cDone.response.stopReason).toBe("end_turn");
    expect(outcome.settled).toEqual(["b", "c"]);
    const chunks = chunksIn(h.seen);
    expect(chunks.map((c) => c.text)).toEqual(["A done", "both answered"]);
    expect(chunks[1]!.at).toBeLessThanOrEqual(outcome.bDone.at);
    expect(chunks[1]!.at).toBeLessThanOrEqual(outcome.cDone.at);
    expect(llm.calls).toHaveLength(2);
    const consumed = JSON.stringify(llm.calls[1]?.user);
    expect(consumed).toContain("B");
    expect(consumed).toContain("C");
  });

  /**
   * @case The tool calls of the turn answering a queued message reach the editor
   * @preconditions Prompt A held in a tool; B arrives; A is released; the turn answering B calls a tool before replying
   * @expectedResult The tool call and its result arrive as updates while B's request is open, followed by B's answer
   */
  test("the boundary turn's tool calls stream to the held request", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "A done" },
      { toolCalls: [{ toolName: "echo", input: { what: "hi" } }] },
      { text: "echoed" },
    );

    const outcome = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const a = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await waitForEntry(1);
      const b = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      const before = h!.seen.length;
      release!();
      await a;
      const bResponse = await b;
      session.dispose();
      return { bResponse, before };
    });

    expect(outcome.bResponse.stopReason).toBe("end_turn");
    const afterRelease = h.seen.slice(outcome.before).map((entry) => {
      const update = entry.update as {
        sessionUpdate: string;
        content?: { text?: string };
        status?: string;
      };
      return update.sessionUpdate === "agent_message_chunk"
        ? `chunk:${update.content?.text}`
        : `${update.sessionUpdate}:${update.status ?? ""}`;
    });
    // The first completion is the slow hand A was held in; everything
    // after A's answer belongs to the turn that answered B.
    expect(afterRelease).toEqual([
      "tool_call_update:completed",
      "chunk:A done",
      "tool_call:in_progress",
      "tool_call_update:completed",
      "chunk:echoed",
    ]);
  });

  /**
   * @case Stopping the running turn does not lose what was typed while it ran
   * @preconditions Prompt A held in a tool; B arrives; the editor cancels the session
   * @expectedResult A's request returns cancelled, and B's request returns end_turn with B's answer, produced by the next turn without anything further being sent
   */
  test("cancel returns cancelled for the running turn and the queued message is still answered", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "B answered" },
    );

    const outcome = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const a = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await waitForEntry(1);
      const b = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      await agent.notify("session/cancel", { sessionId: session.sessionId });
      const aResponse = await a;
      const bResponse = await b;
      session.dispose();
      return { aResponse, bResponse };
    });

    expect(outcome.aResponse.stopReason).toBe("cancelled");
    expect(outcome.bResponse.stopReason).toBe("end_turn");
    expect(chunksIn(h.seen).map((c) => c.text)).toEqual(["B answered"]);
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls[1]?.user)).toContain("B");
  });
});
