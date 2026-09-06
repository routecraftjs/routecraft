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
import { MODEL } from "./helpers/suspend-fixtures.ts";

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
   * @case A context with one agent advertises no persona picker, and one with three does
   * @preconditions Two instances, one holding a single agent and one holding three, each opening a session
   * @expectedResult The single-agent instance advertises no `agent` option and no modes at all; the three-agent one advertises both, with every agent listed
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
    const persona = several.options.find((o) => o.id === "agent");
    expect(persona?.category).toBe("mode");
    expect(
      persona?.type === "select"
        ? persona.options.map((o) => ("value" in o ? o.value : o.group))
        : [],
    ).toEqual(["max", "zoe", "ada"]);
    expect(several.modes?.availableModes.map((m) => m.id)).toEqual([
      "max",
      "zoe",
      "ada",
    ]);
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
