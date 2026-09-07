/**
 * The transport streams, and the merge keeps the real ordering.
 *
 * This is the regression test for the assumption the whole block rests on:
 * that the SSE channel the SDK holds open survives `ingress.mountHttp`
 * under `longLived: true` without buffering. A buffered stream delivers
 * every update at once when the turn ends, so the measurement is the gaps
 * between arrivals, taken over a real socket.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { agentPlugin, tools } from "../src/index.ts";
import {
  acpHarness,
  describeUpdates,
  type AcpHarness,
} from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** How far apart the scripted deltas are emitted. */
const GAP_MS = 200;

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
  },
};

/** How long the slow hand takes, so a turn outlives its connection. */
const SLOW_MS = 150;

/** A hand slow enough that the connection can go while it is still running. */
const slowEchoFn = {
  description: "Echoes what it was given, slowly",
  input: z.object({ what: z.string() }),
  handler: async (input: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return `echo:${(input as { what: string }).what}`;
  },
};

/** A tool the turn calls between two deltas. */
const echoFn = {
  description: "Echoes what it was given",
  input: z.object({ what: z.string() }),
  handler: (input: unknown) =>
    Promise.resolve(`echo:${(input as { what: string }).what}`),
};

describe("the ACP transport", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (h) await h.t.stop();
    h = undefined;
  });

  /**
   * @case Updates reach the editor as they happen, not in one batch at the end
   * @preconditions One agent scripted to emit three token deltas 200ms apart, driven over a real Streamable HTTP connection
   * @expectedResult All three arrive as separate message chunks with gaps near 200ms, and every one of them arrives before the prompt response, which a buffered stream cannot do
   */
  test("session updates stream rather than buffer", async () => {
    h = await acpHarness({ agents: AGENT });
    llm.script.push({
      deltas: [
        { text: "one", delayMs: GAP_MS },
        { text: "two", delayMs: GAP_MS },
        { text: "three", delayMs: GAP_MS },
      ],
      text: "onetwothree",
    });

    const finishedAt = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await session.prompt("go");
        return Date.now();
      }),
    );

    const chunks = h.seen.filter(
      (entry) =>
        (entry.update as { sessionUpdate: string }).sessionUpdate ===
        "agent_message_chunk",
    );
    expect(chunks).toHaveLength(3);

    // The measurement: a buffered stream hands all three over together, so
    // the gaps collapse to near zero. Half the scripted gap is the floor
    // that separates the two outcomes without pinning a timer.
    const gaps = chunks
      .slice(1)
      .map((entry, index) => entry.at - chunks[index]!.at);
    for (const gap of gaps) expect(gap).toBeGreaterThan(GAP_MS / 2);

    // And every chunk was on the wire before the turn was reported done.
    for (const chunk of chunks)
      expect(chunk.at).toBeLessThanOrEqual(finishedAt);
  });

  /**
   * @case A tool call raised between two deltas arrives between them
   * @preconditions One turn emitting a delta then calling a tool, a second emitting another delta, over one connection
   * @expectedResult The wire order is chunk, tool call, tool result, chunk: two producers with no ordering between them enqueue into one queue at the moment each thing happened
   */
  test("deltas and tool events merge in the real order", async () => {
    h = await acpHarness({
      agents: { max: { ...AGENT.max, tools: tools(["echo"]) } },
      plugins: [agentPlugin({ functions: { echo: echoFn } })],
    });
    llm.script.push(
      {
        deltas: [{ text: "before", delayMs: 20 }],
        toolCalls: [{ toolName: "echo", input: { what: "hi" } }],
      },
      { deltas: [{ text: "after", delayMs: 20 }], text: "beforeafter" },
    );

    await h.connect((agent) =>
      agent
        .buildSession("/work")
        .withSession((session) => session.prompt("go")),
    );

    expect(describeUpdates(h.seen)).toEqual([
      "chunk:before",
      "tool_call:in_progress",
      "tool_call_update:completed",
      "chunk:after",
    ]);
  });

  /**
   * @case A tool call is always visible, and its payloads can be withheld
   * @preconditions The same turn on two instances, one at the default and one with toolCallPayloads false
   * @expectedResult Both report the call and its completion; the default carries rawInput and rawOutput and the withholding one carries neither, so an instance can hide a hand's arguments without hiding that it ran
   */
  test("tool payloads are on by default and can be withheld", async () => {
    const script = (): void => {
      llm.script.push(
        { toolCalls: [{ toolName: "echo", input: { what: "secret" } }] },
        { text: "done" },
      );
    };
    const payloadsOf = async (
      toolCallPayloads: boolean | undefined,
    ): Promise<Array<{ rawInput?: unknown; rawOutput?: unknown }>> => {
      h = await acpHarness({
        agents: { max: { ...AGENT.max, tools: tools(["echo"]) } },
        plugins: [agentPlugin({ functions: { echo: echoFn } })],
        ...(toolCallPayloads === undefined
          ? {}
          : { acp: { toolCallPayloads } }),
      });
      llm.reset();
      script();
      await h.connect((agent) =>
        agent
          .buildSession("/work")
          .withSession((session) => session.prompt("go")),
      );
      const calls = h.seen
        .map((entry) => entry.update as Record<string, unknown>)
        .filter((update) =>
          String(update["sessionUpdate"]).startsWith("tool_call"),
        );
      await h.t.stop();
      h = undefined;
      return calls;
    };

    const shown = await payloadsOf(undefined);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatchObject({ rawInput: { what: "secret" } });
    expect(shown[1]).toMatchObject({ rawOutput: "echo:secret" });

    const withheld = await payloadsOf(false);
    expect(withheld).toHaveLength(2);
    expect(withheld[0]).not.toHaveProperty("rawInput");
    expect(withheld[1]).not.toHaveProperty("rawOutput");
    // The call itself is still visible, which is the whole point of the
    // option being about the payloads rather than about the call.
    expect(withheld[0]).toMatchObject({ status: "in_progress" });
    expect(withheld[1]).toMatchObject({ status: "completed" });
  });

  /**
   * @case Reasoning deltas reach the editor on the thinking channel
   * @preconditions One turn emitting a reasoning delta and a text delta
   * @expectedResult The reasoning arrives as agent_thought_chunk and the text as agent_message_chunk, so an editor can render the two differently
   */
  test("thinking and speaking are different channels", async () => {
    h = await acpHarness({ agents: AGENT });
    llm.script.push({
      deltas: [{ text: "hmm", kind: "reasoning" }, { text: "answer" }],
      text: "answer",
    });

    await h.connect((agent) =>
      agent
        .buildSession("/work")
        .withSession((session) => session.prompt("go")),
    );

    expect(
      h.seen.map(
        (entry) => (entry.update as { sessionUpdate: string }).sessionUpdate,
      ),
    ).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
  });

  /**
   * @case A turn whose tool events land after the editor has gone is survivable
   * @preconditions A turn calling a slow hand, on a connection the client closes as soon as the turn returns, with an unhandled-rejection guard installed
   * @expectedResult The instance stays up and no rejection escapes to the process. This exercises the disconnect sequence rather than pinning the send-failure branch: see the note in the runtime's `tell`, which handles a rejection this test could not be made to provoke
   */
  test("a disconnect around a turn is survivable", async () => {
    h = await acpHarness({
      agents: {
        max: { ...AGENT.max, tools: tools(["echo"]) },
      },
      plugins: [agentPlugin({ functions: { echo: slowEchoFn } })],
    });
    llm.script.push(
      { toolCalls: [{ toolName: "echo", input: { what: "hi" } }] },
      { text: "done" },
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const stopReason = await h.connect((agent) =>
        agent
          .buildSession("/work")
          .withSession((session) => session.prompt("go")),
      );
      expect(stopReason.stopReason).toBe("end_turn");
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
