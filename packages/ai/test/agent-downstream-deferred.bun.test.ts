import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { craft, direct, MemoryDeferralStore } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
} from "../src/index.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { DEFERRED_TOOL_PLACEHOLDER } from "../src/agent/deferral-state.ts";
import { recordsFor } from "./helpers/session-stores.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** Capture every session write, including inbox values consumed before inspection. */
function observedSessions(store: MemoryDeferralStore, writes: string[]) {
  return new Proxy(recordsFor(store), {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "create" || key === "replace") {
        return (...args: unknown[]) => {
          writes.push(JSON.stringify(args));
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Bound a wait for an autonomous inbox turn so a missing delivery fails. */
async function waitForCalls(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (llm.calls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(llm.calls).toHaveLength(count);
}

describe("downstream deferral token boundary", () => {
  let t: TestContext | undefined;
  beforeEach(() => llm.reset());
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A downstream receipt is replaced before model results and snapshots are recorded
   * @preconditions A session tool calls a static defer route, directly or after a JSON round trip
   * @expectedResult The model receives only a pending marker; no prompt, session write, or tool snapshot contains the real token, and the action stays waiting
   */
  test.each([false, true])(
    "ordinary result hides the token (serialized: %s)",
    async (serialized) => {
      const store = new MemoryDeferralStore();
      const writes: string[] = [];
      const snapshots: unknown[] = [];
      let token = "";
      let actionRuns = 0;
      t = await testContext()
        .with({
          deferral: { store },
          sessions: { store: observedSessions(store, writes) },
          plugins: [
            llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
            agentPlugin({
              functions: {
                park: serialized
                  ? {
                      description: "A transport-returned acknowledgment",
                      input: z.object({}),
                      handler: async () =>
                        JSON.parse(
                          JSON.stringify(
                            await t!.client.sendDirect("park", {}),
                          ),
                        ),
                    }
                  : directTool("park"),
              },
              agents: {
                reviewer: {
                  description: "Review",
                  model: MODEL,
                  system: "test",
                  tools: tools(["park"]),
                },
              },
            }),
          ],
        })
        .routes([
          craft()
            .id("park")
            .description("Ask approval")
            .input({ body: z.object({}) })
            .from(direct())
            .process((ex) => {
              token = ex.deferral.token;
              return ex;
            })
            .defer({ ttl: "1h" })
            .process((ex) => {
              actionRuns++;
              return ex;
            }),
          craft()
            .id("chat")
            .from(direct())
            .to(agent("reviewer", { session: () => "review-session" })),
        ])
        .build();
      t.ctx.on("route:agent:tool:result", ({ details }) => {
        snapshots.push(details._snapshot);
      });
      await t.startAndWaitReady();
      llm.script.push(
        { toolCalls: [{ toolName: "park", input: {} }] },
        { text: "Waiting for approval." },
      );
      const reply = await t.client.sendDirect("chat", "ask");
      expect(token.length).toBeGreaterThan(0);
      expect(snapshots).toEqual([{ output: DEFERRED_TOOL_PLACEHOLDER }]);
      for (const captured of [
        JSON.stringify(llm.calls),
        JSON.stringify(reply),
        JSON.stringify(snapshots),
        writes.join("\n"),
      ]) {
        expect(captured).not.toContain(token);
      }
      expect(actionRuns).toBe(0);
      expect(
        await store.list({ state: "waiting", routeId: "park", limit: 10 }),
      ).toHaveLength(1);
    },
  );

  /**
   * @case A background receipt cannot bypass the bridge through session inbox delivery
   * @preconditions The first turn ends while the downstream route waits, then that route defers and delivers to the idle session
   * @expectedResult Delivery fails explicitly with AI1006, the handle settles, no model or persisted session sees the token, and the downstream approval remains pending without executing its action
   */
  test("background delivery fails safely without leaking or completing the pending action", async () => {
    const store = new MemoryDeferralStore();
    const writes: string[] = [];
    const snapshots: unknown[] = [];
    const failures: unknown[] = [];
    let token = "";
    let actionRuns = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t = await testContext()
      .with({
        deferral: { store },
        sessions: { store: observedSessions(store, writes) },
        shutdown: { timeout: 500 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            functions: { park: directTool("park", { background: true }) },
            agents: {
              reviewer: {
                description: "Review",
                model: MODEL,
                system: "test",
                tools: tools(["park"]),
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("park")
          .description("Ask approval")
          .input({ body: z.object({}) })
          .from(direct())
          .process(async (ex) => {
            await gate;
            token = ex.deferral.token;
            return ex;
          })
          .defer({ ttl: "1h" })
          .process((ex) => {
            actionRuns++;
            return ex;
          }),
        craft()
          .id("chat")
          .from(direct())
          .to(agent("reviewer", { session: () => "review-session" })),
      ])
      .build();
    t.ctx.on("route:agent:tool:result", ({ details }) => {
      snapshots.push(details._snapshot);
    });
    t.ctx.on("route:agent:session:background:failed", ({ details }) => {
      failures.push(details);
    });
    try {
      await t.startAndWaitReady();
      llm.script.push(
        { toolCalls: [{ toolName: "park", input: {} }] },
        { text: "Waiting." },
      );
      await t.client.sendDirect("chat", "ask");
      llm.script.push({
        text: "The application must handle this pending approval.",
      });
      release();
      await waitForCalls(2);
      await t.ctx.getRouteById("chat")!.drain();
      expect(token.length).toBeGreaterThan(0);
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(llm.calls[1])).toContain("AI1006");
      expect(JSON.stringify(llm.calls[1])).toContain("still awaiting approval");
      for (const captured of [
        JSON.stringify(llm.calls),
        JSON.stringify(snapshots),
        JSON.stringify(failures),
        writes.join("\n"),
      ]) {
        expect(captured).not.toContain(token);
      }
      expect(
        (
          await AgentSessionRuntime.for(t.ctx).summary(
            "review-session",
            "operator",
          )
        )?.background,
      ).toBe(0);
      expect(actionRuns).toBe(0);
      expect(
        await store.list({ state: "waiting", routeId: "park", limit: 10 }),
      ).toHaveLength(1);
    } finally {
      release();
    }
  });
});
