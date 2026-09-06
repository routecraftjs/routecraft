/**
 * What an agent offers a person a choice about.
 *
 * Two spellings of `model:` and `reasoning:` in an agent file, the rule
 * that a list of one offers nothing, the refusal of a stored choice the
 * agent never advertised, and the turn boundary a choice takes effect at.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  agents,
  llmPlugin,
  type AgentResult,
} from "../src/index.ts";
import { loadAgentFiles } from "../src/agent/loader.ts";
import {
  advertisedModels,
  advertisedReasoning,
  offersAChoice,
} from "../src/agent/advertised.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { recordsFor } from "./helpers/session-stores.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const SONNET = "anthropic:claude-sonnet-4-6";
const OPUS = "anthropic:claude-opus-4-7";
const HAIKU = "anthropic:claude-haiku-4-5";

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;

describe("agent files advertise model and thinking-level lists", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function makeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "rc-choices-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    return dir;
  }

  function agentFile(frontmatter: string): string {
    return makeDir({
      "zoe.md": `---
name: zoe
description: Operator
${frontmatter}
---

Be useful.
`,
    });
  }

  /**
   * @case A scalar model and a Claude alias both still resolve, unchanged by the list form
   * @preconditions Two agent files, one carrying `model: sonnet` and one the full provider:model reference
   * @expectedResult Each loads with the pinned id on `model` and advertises no list, so an unmodified Claude subagent file behaves exactly as it did before lists existed
   */
  test("a scalar model still resolves, alias or full form", async () => {
    const aliased = await loadAgentFiles(agentFile("model: sonnet"));
    expect(aliased[0]?.agent.model).toBe(SONNET);
    expect(aliased[0]?.agent.models).toBeUndefined();

    const full = await loadAgentFiles(agentFile(`model: ${OPUS}`));
    expect(full[0]?.agent.model).toBe(OPUS);
    expect(full[0]?.agent.models).toBeUndefined();
  });

  /**
   * @case A model list resolves entry by entry and the first entry is the default
   * @preconditions An agent file whose `model:` is a list mixing two aliases and one full reference
   * @expectedResult Every entry resolves through the same alias table, `models` keeps the authored order, and `model` is the first entry
   */
  test("a model list resolves entry by entry, first is the default", async () => {
    const loaded = await loadAgentFiles(
      agentFile(`model: [sonnet, opus, "${HAIKU}"]`),
    );
    expect(loaded[0]?.agent.models).toEqual([SONNET, OPUS, HAIKU]);
    expect(loaded[0]?.agent.model).toBe(SONNET);
  });

  /**
   * @case One bad entry in a model list names its own index
   * @preconditions An agent file whose second model entry is neither an alias nor a provider:model reference
   * @expectedResult The load throws RC5003 naming entry 1, so the offending entry is findable without counting
   */
  test("a bad model list entry names its index", async () => {
    const dir = agentFile("model: [sonnet, nonsense, opus]");
    await expect(loadAgentFiles(dir)).rejects.toThrow(/"model" entry 1/);
  });

  /**
   * @case `inherit` is a scalar spelling and never a choice
   * @preconditions One file with `model: inherit`, one with `inherit` inside a list
   * @expectedResult The scalar leaves the model to the context default; the list entry is refused naming its index, because a value that names no model cannot be offered as one
   */
  test("inherit is a scalar spelling and not a list entry", async () => {
    const scalar = await loadAgentFiles(agentFile("model: inherit"));
    expect(scalar[0]?.agent.model).toBeUndefined();
    expect(scalar[0]?.agent.models).toBeUndefined();

    await expect(
      loadAgentFiles(agentFile("model: [sonnet, inherit]")),
    ).rejects.toThrow(/entry 1 is "inherit"/);
  });

  /**
   * @case A reasoning list resolves and a bad level names its index
   * @preconditions One file listing three valid levels, one whose second entry is not a level
   * @expectedResult The valid file keeps the authored order with the first as the default; the invalid one throws RC5003 naming entry 1 and the four levels
   */
  test("a reasoning list resolves, and a bad level names its index", async () => {
    const loaded = await loadAgentFiles(
      agentFile("reasoning: [medium, high, none]"),
    );
    expect(loaded[0]?.agent.reasoningLevels).toEqual([
      "medium",
      "high",
      "none",
    ]);
    expect(loaded[0]?.agent.reasoning).toBe("medium");

    await expect(
      loadAgentFiles(agentFile("reasoning: [medium, loud]")),
    ).rejects.toThrow(/"reasoning" entry 1 must be one of/);
  });

  /**
   * @case A list of one offers nothing, exactly as a scalar does
   * @preconditions One agent file with `model: [sonnet]`, one with `model: sonnet`
   * @expectedResult Both resolve to the same default and both advertise a one-entry list, which `offersAChoice` reports as no choice, so the two spellings differ only in intent
   */
  test("a list of one advertises nothing", async () => {
    const list = (await loadAgentFiles(agentFile("model: [sonnet]")))[0]!.agent;
    const scalar = (await loadAgentFiles(agentFile("model: sonnet")))[0]!.agent;

    expect(list.model).toBe(SONNET);
    expect(advertisedModels(list)).toEqual([SONNET]);
    expect(advertisedModels(scalar)).toEqual([SONNET]);
    expect(offersAChoice(advertisedModels(list))).toBe(false);
    expect(offersAChoice(advertisedModels(scalar))).toBe(false);
  });

  /**
   * @case An agent that lists nothing advertises nothing, rather than the context default
   * @preconditions An agent file with no `model:` and no `reasoning:`, so both come from agentPlugin defaults at dispatch
   * @expectedResult Both advertised lists are empty: a context-level default is not the persona's to offer as a choice
   */
  test("an agent with no model advertises no models", async () => {
    const loaded = (await loadAgentFiles(agentFile("maxTurns: 3")))[0]!.agent;
    expect(advertisedModels(loaded)).toEqual([]);
    expect(advertisedReasoning(loaded)).toEqual([]);
  });

  /**
   * @case An empty list is refused rather than read as "offers nothing"
   * @preconditions An agent file whose `model:` is an empty YAML list
   * @expectedResult RC5003 naming the empty list, because a key written with no values is a mistake rather than a way of saying nothing
   */
  test("an empty model list is refused", async () => {
    await expect(loadAgentFiles(agentFile("model: []"))).rejects.toThrow(
      /"model" is an empty list/,
    );
  });

  /**
   * @case An overrides map may supply the lists an agent file did not
   * @preconditions An agent file with a scalar model, overridden through agents() with a matching models list
   * @expectedResult The override lands on the loaded agent, so a deployment can widen what a persona offers without editing the file
   */
  test("agents() overrides can supply the lists", async () => {
    const dir = agentFile(`model: ${SONNET}`);
    const loaded = await agents(dir, {
      zoe: {
        models: [SONNET, OPUS],
        reasoning: "low",
        reasoningLevels: ["low", "high"],
      },
    });
    expect(loaded["zoe"]?.models).toEqual([SONNET, OPUS]);
    expect(loaded["zoe"]?.reasoningLevels).toEqual(["low", "high"]);
  });

  /**
   * @case A default outside its own list is refused where the two halves meet
   * @preconditions An agent file with `model: sonnet`, overridden with a models list that does not contain sonnet
   * @expectedResult RC5003 naming both, because a chooser whose current value is not among its options is not renderable and the mismatch can only appear once the file and the override are merged
   */
  test("a default outside its own list is refused", async () => {
    const dir = agentFile(`model: ${SONNET}`);
    await expect(
      agents(dir, { zoe: { models: [OPUS, HAIKU] } }),
    ).rejects.toThrow(/not one of "models"/);
  });
});

describe("a conversation's own choices", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  function routes(sink: ReturnType<typeof spy>): RouteDefinition[] {
    return craft()
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(agent<ChatMessage>("zoe", { session: (ex) => ex.body.session }))
      .to(sink)
      .build();
  }

  async function boot(): Promise<TestContext> {
    const store = new MemorySuspensionStore();
    return testContext()
      .with({
        suspension: { store },
        sessions: { store: recordsFor(store) },
        shutdown: { timeout: 500 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              zoe: {
                description: "Operator",
                model: SONNET,
                models: [SONNET, OPUS],
                reasoning: "medium",
                reasoningLevels: ["medium", "high"],
                system: "be useful",
                user: (ex) => (ex.body as ChatMessage).message,
              },
            },
          }),
        ],
      })
      .routes(routes(spy()))
      .build();
  }

  const send = (ctx: TestContext, body: ChatMessage): Promise<AgentResult> =>
    ctx.client.sendDirect("chat", body, {}) as Promise<AgentResult>;

  /**
   * @case A stored choice the agent offers is applied by the turn that runs next
   * @preconditions A session that has already run one turn on the default model, then configured onto the second advertised model
   * @expectedResult The first call uses the agent's default and the second uses the chosen model, so a change made between turns reaches the reply after it
   */
  test("an advertised override reaches the next turn", async () => {
    t = await boot();
    await t.startAndWaitReady();
    llm.script.push({ text: "one" }, { text: "two" });

    await send(t, { session: "s", message: "hello" });
    expect(llm.calls[0]?.modelId).toBe("claude-sonnet-4-6");

    await AgentSessionRuntime.for(t.ctx).configure(
      { agent: "zoe", session: "s" },
      { model: OPUS, reasoning: "high" },
    );

    await send(t, { session: "s", message: "again" });
    expect(llm.calls[1]?.modelId).toBe("claude-opus-4-7");
    expect(llm.calls[1]?.options.reasoning).toBe("high");
  });

  /**
   * @case A choice the agent does not offer is refused where it would be written
   * @preconditions The same agent, asked to store a model outside its advertised list
   * @expectedResult AI1017 naming the value and the list, and the record still carries no override, so nothing downstream has to re-check what it reads
   */
  test("an unadvertised override is refused with AI1017", async () => {
    t = await boot();
    await t.startAndWaitReady();
    llm.script.push({ text: "one" });
    await send(t, { session: "s", message: "hello" });

    const runtime = AgentSessionRuntime.for(t.ctx);
    const key = { agent: "zoe", session: "s" };
    await expect(
      runtime.configure(key, { model: HAIKU }),
    ).rejects.toMatchObject({ rc: "AI1017" });

    const record = await runtime.store.load(key);
    expect(record?.overrides).toBeUndefined();
  });

  /**
   * @case A choice that was valid when it was stored is ignored once the agent stops offering it
   * @preconditions A record carrying a model override written directly, against an agent whose list does not contain it
   * @expectedResult The turn runs on the agent's own default rather than the stored value, because an agent file can change under a record that was valid when it was written
   */
  test("a stored choice the agent no longer offers is not run", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const key = { agent: "zoe", session: "s" };
    // Written straight to the store, which is the only way this state can
    // arise: `configure` refuses it, so the record has to predate the list.
    await runtime.store.update(key, (record) => ({
      ...record,
      overrides: { model: HAIKU },
    }));

    llm.script.push({ text: "one" });
    await send(t, { session: "s", message: "hello" });
    expect(llm.calls[0]?.modelId).toBe("claude-sonnet-4-6");
  });
});
