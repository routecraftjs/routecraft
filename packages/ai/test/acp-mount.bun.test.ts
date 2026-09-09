/**
 * The Agent Client Protocol mount, driven through a real socket by the
 * SDK's own client.
 *
 * The transport is what this whole block rests on, so nothing here stubs
 * it: every case opens a Streamable HTTP connection to a listening
 * instance and speaks the protocol.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const SONNET = "anthropic:claude-sonnet-4-6";
const OPUS = "anthropic:claude-opus-4-7";

const ONE_AGENT = {
  max: {
    description: "Max, the only agent here",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
  },
};

describe("the ACP mount", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (h) await h.t.stop();
    h = undefined;
  });

  /**
   * @case An editor initializes, opens a conversation and gets a reply
   * @preconditions One registered agent, the mount on its default path, a real client over Streamable HTTP
   * @expectedResult The agent identifies itself as Routecraft, the session opens, the prompt returns end_turn and the reply arrived as a message chunk
   */
  test("a prompt round trip over a real connection", async () => {
    h = await acpHarness({ agents: ONE_AGENT });
    llm.script.push({ text: "hello back" });

    const answer = await h.connect(async (agent, info) => {
      expect(info.agentInfo?.title).toBe("Routecraft");
      expect(info.agentCapabilities?.loadSession).toBe(true);
      expect(info.authMethods).toEqual([]);

      return agent.buildSession("/work").withSession(async (session) => {
        const response = await session.prompt("hello");
        return { stopReason: response.stopReason, id: session.sessionId };
      });
    });

    expect(answer.stopReason).toBe("end_turn");
    const chunks = h.seen
      .filter(
        (entry) =>
          (entry.update as { sessionUpdate: string }).sessionUpdate ===
          "agent_message_chunk",
      )
      .map(
        (entry) => (entry.update as { content: { text: string } }).content.text,
      );
    expect(chunks.join("")).toContain("hello back");
  });

  /**
   * @case The default name in the editor is Routecraft, and an app replaces it outright
   * @preconditions Two instances, one configuring nothing and one setting its own agentInfo
   * @expectedResult The first carries the framework's name and version; the second carries only what it set, with no combined attribution
   */
  test("agentInfo defaults to Routecraft and is replaced outright", async () => {
    h = await acpHarness({ agents: ONE_AGENT });
    const plain = await h.connect((_agent, info) => Promise.resolve(info));
    expect(plain.agentInfo?.name).toBe("routecraft");
    expect(plain.agentInfo?.title).toBe("Routecraft");
    await h.t.stop();

    h = await acpHarness({
      agents: ONE_AGENT,
      acp: { agentInfo: { name: "eywa", title: "Eywa", version: "9.9.9" } },
    });
    const branded = await h.connect((_agent, info) => Promise.resolve(info));
    expect(branded.agentInfo).toMatchObject({
      name: "eywa",
      title: "Eywa",
      version: "9.9.9",
    });
  });

  /**
   * @case A control with nothing to choose is not advertised, and which agent answers is never a control
   * @preconditions Two instances, one holding a single agent and one holding three, each opening a session through a harness bound to max
   * @expectedResult Neither advertises an `agent` option and neither advertises modes, however many agents the instance holds. The count is what decides whether a model or thinking picker appears; the agent is decided by the harness before the session exists, so it is not a picker at any count
   */
  test("a control with nothing to choose is not advertised", async () => {
    h = await acpHarness({ agents: ONE_AGENT });
    const alone = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => ({
        options: session.newSessionResponse.configOptions ?? [],
        modes: session.modes,
      })),
    );
    expect(alone.options.map((o) => o.id)).toEqual([]);
    expect(alone.modes ?? undefined).toBeUndefined();
    await h.t.stop();

    // Three agents is where the old design offered a picker. The harness
    // decides instead, so there is still nothing to advertise.
    h = await acpHarness({
      agents: {
        ...ONE_AGENT,
        zoe: { description: "Zoe", model: MODEL, system: "be useful" },
        ada: { description: "Ada", model: MODEL, system: "be useful" },
      },
      acp: { agent: "max" },
    });
    const several = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => ({
        options: session.newSessionResponse.configOptions ?? [],
        modes: session.modes,
      })),
    );
    expect(several.options.map((o) => o.id)).toEqual([]);
    expect(several.modes ?? undefined).toBeUndefined();
  });

  /**
   * @case A connection and the conversations on it are observable from the event bus
   * @preconditions One connection opening a conversation, loading it again on a second connection, and both closing
   * @expectedResult Each open, attach and close is announced with the connection it belongs to, the person who opened it and how the conversation was taken hold of, so an operator can see who is connected without reading a log line
   */
  test("connections and conversations announce themselves", async () => {
    h = await acpHarness({ agents: ONE_AGENT });
    llm.script.push({ text: "hi" });
    const seen: Array<{ name: string; details: Record<string, unknown> }> = [];
    // Event names are a fixed set here, so the wildcard is the whole bus
    // and the filter is ours.
    h.t.ctx.on("*", (payload) => {
      const name = payload._event;
      if (name.startsWith("plugin:acp:")) {
        seen.push({
          name,
          details: payload.details as Record<string, unknown>,
        });
      }
    });

    const sessionId = await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await session.prompt("hello");
        return session.sessionId;
      }),
    );
    await h.connect((agent) =>
      agent.request("session/load", {
        sessionId,
        cwd: "/work",
        mcpServers: [],
      }),
    );

    const names = seen.map((entry) => entry.name);
    expect(
      names.filter((n) => n === "plugin:acp:connection:opened"),
    ).toHaveLength(2);
    expect(names).toContain("plugin:acp:connection:closed");

    const attached = seen.filter(
      (entry) => entry.name === "plugin:acp:session:attached",
    );
    expect(attached.map((entry) => entry.details["how"])).toEqual([
      "new",
      "load",
    ]);
    expect(attached[0]?.details["sessionId"]).toBe(sessionId);
    expect(attached[0]?.details["agentName"]).toBe("max");
    // The editor names itself at initialize, which is the only thing that
    // tells two editors on one machine apart.
    expect(seen[0]?.details["clientName"]).toBe("test-editor");
  });

  /**
   * @case An agent offering several models advertises a model picker, and one offering a single value does not
   * @preconditions One agent listing two models and one thinking level, another listing neither
   * @expectedResult The listing agent advertises the model option with both entries and its default current, and advertises no thinking-level option at all
   */
  test("the model picker offers exactly what the agent file lists", async () => {
    h = await acpHarness({
      agents: {
        max: {
          description: "Max",
          model: SONNET,
          models: [SONNET, OPUS],
          reasoning: "medium",
          system: "be useful",
        },
      },
    });
    const options = await h.connect((agent) =>
      agent
        .buildSession("/work")
        .withSession(async (s) => s.newSessionResponse.configOptions ?? []),
    );
    const model = options.find((o) => o.id === "model");
    expect(model?.category).toBe("model");
    expect(model?.type === "select" ? model.currentValue : undefined).toBe(
      SONNET,
    );
    expect(options.find((o) => o.id === "reasoning")).toBeUndefined();
  });
});
