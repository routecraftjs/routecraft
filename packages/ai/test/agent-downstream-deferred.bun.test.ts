import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  DEFERRAL_RUNTIME,
  craft,
  direct,
  noop,
  recovery,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import type { CraftPlugin } from "@routecraft/routecraft";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  type AgentResult,
} from "../src/index.ts";
import { DEFERRED_TOOL_PLACEHOLDER } from "../src/agent/deferral-state.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

type PluginFns = NonNullable<
  NonNullable<Parameters<typeof agentPlugin>[0]>["functions"]
>;
function plugins(functions: PluginFns): CraftPlugin[] {
  return [
    llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
    agentPlugin({ functions }),
  ];
}

/** What the archive capability accepts. */
const ArchiveInput = z.object({ session: z.string() });

describe("a tool whose downstream route parks", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A downstream Deferred body is recorded as the placeholder and the turn continues
   * @preconditions An agent whose tool forwards into a route that parks from its error path, then one more scripted text turn
   * @expectedResult The tool result the model sees is DEFERRED_TOOL_PLACEHOLDER, the agent's own run does not park, and the resume token appears nowhere in the model's context, the thread, or the telemetry snapshot
   */
  test("the token reaches neither the model, the thread, nor telemetry", async () => {
    const sink = spy();
    const snapshots: unknown[] = [];
    llm.script.push({
      toolCalls: [{ toolName: "archive", input: { session: "s-1" } }],
    });
    llm.script.push({ text: "I have asked an admin to approve that." });

    t = await testContext()
      .with({
        deferral: {},
        // The shipped shape: a direct() capability exposed as a tool, so
        // the handler resolves with the ROUTE's body, which is the
        // framework's Deferred acknowledgment once that route parks.
        plugins: plugins({ archive: directTool("archive") }),
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({
              model: MODEL,
              system: "be useful",
              tools: tools(["archive"]),
            }),
          )
          .to(sink),
        // The downstream capability: it parks rather than failing.
        craft()
          .id("archive")
          .description("Archive a session")
          .input({ body: ArchiveInput })
          .error(() => recovery.defer({ ttl: "4h" }))
          .from(direct())
          .transform(() => {
            throw new Error("needs an admin");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:agent:tool:result", ({ details }) => {
      snapshots.push((details as { _snapshot?: unknown })._snapshot);
    });
    await t.startAndWaitReady();

    const result = (await t.client.sendDirect(
      "assistant",
      "archive s-1",
    )) as AgentResult;

    // The agent's OWN run did not park: the turn continued and produced
    // text. Whether it should park is #737's question, not this one's.
    expect(result.text).toBe("I have asked an admin to approve that.");
    expect(llm.script).toHaveLength(0);
    expect(sink.received).toHaveLength(1);

    // A record exists downstream, so a park really did happen and there is a
    // live token somewhere for it.
    const store = t.ctx.getStore(DEFERRAL_RUNTIME)!.store;
    const waiting = await store.list({ limit: 10, state: "waiting" });
    expect(waiting).toHaveLength(1);
    const deferralId = waiting[0]!.id;

    // What the tool recorded, which is what reaches the model's thread and
    // the telemetry snapshot alike. Asserted as EQUALITY rather than as an
    // absence of the token: the placeholder is a closed two-field object, so
    // matching it exactly proves nothing else rode along.
    expect(snapshots).toEqual([{ output: DEFERRED_TOOL_PLACEHOLDER }]);

    // And the deferral the token signs appears in none of it: not in
    // anything the model was sent, not in the telemetry, not in the reply.
    expect(JSON.stringify(llm.calls)).not.toContain(deferralId);
    expect(JSON.stringify(snapshots)).not.toContain(deferralId);
    expect(JSON.stringify(result)).not.toContain(deferralId);
  });
});
