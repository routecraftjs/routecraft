/**
 * A conversation an editor can leave and pick up again.
 *
 * Reconnect is the load path, not a nicety: ACP version 1 makes a fresh
 * transport connection, initializes again and loads the session, and the
 * transcript is replayed as the updates that produced it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { agentPlugin, tools } from "../src/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { slowTool } from "./helpers/slow-tool.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** A tool the test holds open, so a turn can be cancelled mid-flight. */
const slow = slowTool();

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["slow"]),
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, bounded, so a failure reports as an assertion. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(1);
  expect(condition()).toBe(true);
}

describe("ACP session lifecycle", () => {
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
      plugins: [agentPlugin({ functions: { slow: slow.fn } })],
    });
  }

  /**
   * @case A conversation is picked up on a fresh connection and its transcript replayed
   * @preconditions One conversation with a turn in it, then a second connection loading it by id
   * @expectedResult The load replays what was said, in transcript order and before the response returns, so an editor that lost its stream sees the conversation it left
   */
  test("session/load replays the transcript", async () => {
    h = await boot();
    llm.script.push({ text: "the answer" });

    const sessionId = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await session.prompt("the question");
        return session.sessionId;
      }),
    );

    const before = h.seen.length;
    await h.connect(async (agent) => {
      await agent.request("session/load", {
        sessionId,
        cwd: "/work",
        mcpServers: [],
      });
      // The mount sends every replayed update before it answers. Delivery
      // is the transport's, over the session stream, so the wait is for
      // the client to have read what was already written rather than for
      // the server to have written it.
      await until(() => h!.seen.length - before >= 2);
    });

    const replayed = h.seen.slice(before).map((entry) => {
      const update = entry.update as {
        sessionUpdate: string;
        content?: { text?: string };
      };
      return `${update.sessionUpdate}:${update.content?.text ?? ""}`;
    });
    expect(replayed).toEqual([
      "user_message_chunk:the question",
      "agent_message_chunk:the answer",
    ]);
  });

  /**
   * @case A loaded conversation continues rather than starting over
   * @preconditions A conversation with one turn, loaded on a second connection and prompted again
   * @expectedResult The second turn's thread carries the first exchange, so the model sees the conversation and not a fresh one
   */
  test("a loaded conversation carries its history into the next turn", async () => {
    h = await boot();
    llm.script.push({ text: "first" }, { text: "second" });

    const sessionId = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await session.prompt("one");
        return session.sessionId;
      }),
    );

    await h.connect(async (agent) => {
      await agent.request("session/load", {
        sessionId,
        cwd: "/work",
        mcpServers: [],
      });
      await agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "two" }],
      });
    });

    expect(JSON.stringify(llm.calls[1]?.user)).toContain("one");
    expect(JSON.stringify(llm.calls[1]?.user)).toContain("first");
  });

  /**
   * @case A cancelled turn is reported as cancelled
   * @preconditions A turn held open inside a tool, cancelled by notification while it runs
   * @expectedResult The in-flight prompt returns the cancelled stop reason, which the spec requires whatever happens underneath, and the partial turn is kept rather than discarded
   */
  test("session/cancel stops the turn and the prompt says so", async () => {
    h = await boot();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "after" });

    const stopReason = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const running = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await slow.waitForEntry(1);
      await agent.notify("session/cancel", { sessionId: session.sessionId });
      const response = await running;
      session.dispose();
      return response.stopReason;
    });

    expect(stopReason).toBe("cancelled");
  });

  /**
   * @case The first message names the conversation, and later ones leave the name alone
   * @preconditions Two turns on one session, then a listing
   * @expectedResult The title is the first message, because a listing that renamed itself on every turn would be unreadable
   */
  test("the first message titles the conversation", async () => {
    h = await boot();
    llm.script.push({ text: "a" }, { text: "b" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await session.prompt("plan the release");
        await session.prompt("actually, never mind");
      }),
    );
    const listed = await h.connect((agent) =>
      agent.request("session/list", {}),
    );
    expect(listed.sessions[0]?.title).toBe("plan the release");
  });

  /**
   * @case Closing a session drops the connection's hold and nothing else
   * @preconditions A conversation closed on one connection, then listed and loaded on another
   * @expectedResult It is still listed and still loadable, because the conversation outlives every connection and close deletes nothing
   */
  test("session/close releases the connection, not the conversation", async () => {
    h = await boot();
    llm.script.push({ text: "a" });

    const sessionId = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      await session.prompt("hello");
      session.dispose();
      await agent.request("session/close", { sessionId: session.sessionId });
      return session.sessionId;
    });

    const listed = await h.connect((agent) =>
      agent.request("session/list", {}),
    );
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId]);

    const resumed = await h.connect((agent) =>
      agent.request("session/resume", { sessionId, cwd: "/work" }),
    );
    expect(resumed).toBeDefined();
  });

  /**
   * @case Content the agent never advertised is refused rather than dropped
   * @preconditions A prompt carrying an image block, which the mount advertises as unsupported
   * @expectedResult The call is refused naming the content type, because silently dropping it would answer a question the person did not ask
   */
  test("an image in a prompt is refused", async () => {
    h = await boot();
    await expect(
      h.connect((agent) =>
        agent
          .buildSession("/work")
          .withSession((session) =>
            session.prompt([
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ]),
          ),
      ),
    ).rejects.toThrow(/does not accept "image"/);
  });

  /**
   * @case A resource link in a prompt reaches the model as something it can act on
   * @preconditions A prompt carrying a text block and a resource link
   * @expectedResult The model's user message carries the link's name and uri beside the text, which is what an editor's file reference is
   */
  test("a resource link reaches the model as its name and uri", async () => {
    h = await boot();
    llm.script.push({ text: "ok" });
    await h.connect((agent) =>
      agent.buildSession("/work").withSession((session) =>
        session.prompt([
          { type: "text", text: "look at" },
          {
            type: "resource_link",
            name: "route.ts",
            uri: "file:///a/route.ts",
          },
        ]),
      ),
    );
    const sent = JSON.stringify(llm.calls[0]?.user);
    expect(sent).toContain("look at");
    expect(sent).toContain("route.ts (file:///a/route.ts)");
  });
});
