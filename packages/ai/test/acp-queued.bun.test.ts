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
import { craft, direct } from "@routecraft/routecraft";
import { agent, agentPlugin, tools } from "../src/index.ts";
import { ADAPTER_AGENT_SESSIONS } from "../src/agent/store.ts";
import {
  acpHarness,
  describeUpdates,
  messageChunks,
  type AcpHarness,
} from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { slowTool } from "./helpers/slow-tool.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const slow = slowTool();

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

/**
 * A route of the app's own posting into the same conversation, the way a
 * webhook does. Its agent step has no editor listener, so a boundary turn
 * revived from its continuation streams nothing on its own.
 */
const postRoute = craft()
  .id("post")
  .from<{ session: string; message: string }>(direct())
  .to(
    agent<{ session: string; message: string }>("max", {
      session: (ex) => ex.body.session,
    }),
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("a prompt sent while a turn is running", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
    slow.reset();
  });

  afterEach(async () => {
    slow.release();
    if (h) await h.t.stop();
    h = undefined;
  });

  async function boot(): Promise<AcpHarness> {
    return acpHarness({
      agents: AGENT,
      plugins: [agentPlugin({ functions: { slow: slow.fn, echo: echoFn } })],
      routes: [postRoute],
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

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const a = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);

      const bSentAt = Date.now();
      const b = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "echo 322" }],
      });
      // B is pending while A holds: nothing has been answered for it.
      await sleep(50);
      expect(messageChunks(h!.seen)).toEqual([]);

      slow.release();
      const aResponse = await a;
      const bResponse = await b;
      const bDoneAt = Date.now();
      session.dispose();
      return { aResponse, bResponse, bSentAt, bDoneAt };
    });

    expect(outcome.aResponse.stopReason).toBe("end_turn");
    expect(outcome.bResponse.stopReason).toBe("end_turn");
    const chunks = messageChunks(h.seen);
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

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const a = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);

      const settled: string[] = [];
      const b = editor
        .request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "B" }],
        })
        .then((response) => {
          settled.push("b");
          return { response, at: Date.now() };
        });
      const c = editor
        .request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "C" }],
        })
        .then((response) => {
          settled.push("c");
          return { response, at: Date.now() };
        });
      await sleep(50);

      slow.release();
      await a;
      const [bDone, cDone] = await Promise.all([b, c]);
      session.dispose();
      return { bDone, cDone, settled };
    });

    expect(outcome.bDone.response.stopReason).toBe("end_turn");
    expect(outcome.cDone.response.stopReason).toBe("end_turn");
    expect(outcome.settled).toEqual(["b", "c"]);
    const chunks = messageChunks(h.seen);
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

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const a = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);
      const b = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      const before = h!.seen.length;
      slow.release();
      await a;
      const bResponse = await b;
      session.dispose();
      return { bResponse, before };
    });

    expect(outcome.bResponse.stopReason).toBe("end_turn");
    // The first completion is the slow hand A was held in; everything
    // after A's answer belongs to the turn that answered B.
    expect(describeUpdates(h.seen.slice(outcome.before))).toEqual([
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

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const a = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);
      const b = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      await editor.notify("session/cancel", { sessionId: session.sessionId });
      const aResponse = await a;
      const bResponse = await b;
      session.dispose();
      return { aResponse, bResponse };
    });

    expect(outcome.aResponse.stopReason).toBe("cancelled");
    expect(outcome.bResponse.stopReason).toBe("end_turn");
    expect(messageChunks(h.seen).map((c) => c.text)).toEqual(["B answered"]);
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls[1]?.user)).toContain("B");
  });

  /**
   * @case A message this instance cannot answer is reported cancelled, never as a turn that showed nothing
   * @preconditions Prompt A held in a tool; B arrives and queues; B's inbox entry is taken by another writer (a sibling instance on a shared store) before A ends
   * @expectedResult B's request returns cancelled rather than end_turn, and no reply was streamed for it
   */
  test("a queued message consumed elsewhere returns cancelled, not end_turn", async () => {
    h = await boot();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "A done" });
    const store = h.t.ctx.getStore(ADAPTER_AGENT_SESSIONS)!.store;

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const a = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);
      const b = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      // Another process took the message: the inbox no longer carries it.
      await store.update(session.sessionId, (record) => ({
        ...record!,
        inbox: [],
      }));
      slow.release();
      const aResponse = await a;
      const bResponse = await b;
      session.dispose();
      return { aResponse, bResponse };
    });

    expect(outcome.aResponse.stopReason).toBe("end_turn");
    expect(outcome.bResponse.stopReason).toBe("cancelled");
    expect(messageChunks(h.seen).map((c) => c.text)).toEqual(["A done"]);
    expect(llm.calls).toHaveLength(1);
  });

  /**
   * @case A reply produced on another route's continuation still reaches the editor holding a request
   * @preconditions A turn started by the app's own route (no editor listener) is held in a tool; the editor prompts, queuing behind it; the turn is released and parks on that route; the boundary turn revived there calls a tool and replies without streaming
   * @expectedResult The editor's request returns end_turn after the running turn's tool completion, the boundary turn's tool call and its reply text reached it once, so a conversation shared with a webhook still answers the editor live
   */
  test("a boundary turn on another route's continuation answers the held request", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "posted" },
      { toolCalls: [{ toolName: "echo", input: { what: "hi" } }] },
      { text: "from the other route" },
    );

    const outcome = await h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      const posted = h!.t.client.sendDirect("post", {
        session: session.sessionId,
        message: "W",
      });
      await slow.waitForEntry(1);
      const b = editor.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      await sleep(50);
      const before = h!.seen.length;
      slow.release();
      await posted;
      const bResponse = await b;
      session.dispose();
      return { bResponse, before };
    });

    expect(outcome.bResponse.stopReason).toBe("end_turn");
    // The first completion is the slow hand the app's turn was held in,
    // reported to the editor because it holds a request on the
    // conversation; the reply is the boundary turn's, sent once.
    expect(describeUpdates(h.seen.slice(outcome.before))).toEqual([
      "tool_call_update:completed",
      "tool_call:in_progress",
      "tool_call_update:completed",
      "chunk:from the other route",
    ]);
    expect(llm.calls).toHaveLength(2);
  });

  /**
   * @case Two editors on one conversation are both told the reply, and each once
   * @preconditions Prompt A held in a tool on connection one; connection two loads the same conversation; both send a prompt while A is held; A is released; the answering turn does not stream
   * @expectedResult Both requests return end_turn, and each connection saw the one reply exactly once
   */
  test("two connections holding one conversation each receive the reply once", async () => {
    h = await boot();
    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "A done" },
      { text: "for both editors" },
    );

    let sessionId!: string;
    let second: Promise<{ stopReason: string }> | undefined;
    const first = h.connect(async (editor) => {
      const session = await editor.buildSession("/work").start();
      sessionId = session.sessionId;
      const a = editor.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "A" }],
      });
      await slow.waitForEntry(1);
      const b = editor.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "B" }],
      });
      // The second editor joins while A is held and sends its own.
      second = h!.connect(async (other) => {
        await other.request("session/resume", { sessionId, cwd: "/work" });
        return other.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "C" }],
        });
      });
      await sleep(100);
      slow.release();
      await a;
      const bResponse = await b;
      session.dispose();
      return bResponse;
    });

    const bResponse = await first;
    const cResponse = await second!;
    expect(bResponse.stopReason).toBe("end_turn");
    expect(cResponse.stopReason).toBe("end_turn");
    const repliesOn = (connection: number): number =>
      messageChunks(
        h!.seen.filter((entry) => entry.connection === connection),
      ).filter((chunk) => chunk.text === "for both editors").length;
    expect(repliesOn(1)).toBe(1);
    expect(repliesOn(2)).toBe(1);
  });
});
