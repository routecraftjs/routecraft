/**
 * One conversation is answered by one agent, for its whole life.
 *
 * An agent carries a system prompt and a set of tools, so a conversation
 * that changed agent mid-flight would hand a model a transcript another
 * agent wrote and answers produced with tools it does not have. The
 * binding is made when the session is created and there is no path to
 * change it afterwards, so what these tests hold is that the one way in
 * (a dispatch) refuses, and that nothing a conversation goes through
 * moves the field: turns that succeed, a turn that throws, and a turn
 * that is cancelled.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemoryDeferralStore,
  craft,
  direct,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySessionStore,
  agent,
  agentPlugin,
  llmPlugin,
  tools,
  type AgentResult,
  type SessionStore,
} from "../src/index.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const SONNET = "anthropic:claude-sonnet-4-6";
const HAIKU = "anthropic:claude-haiku-4-5";

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;

/** A tool the test holds open, so a turn can be caught mid-flight. */
let releaseSlow: (() => void) | undefined;
let slowEntries = 0;
const slowFn = {
  description: "Waits until the test releases it",
  input: z.object({}),
  handler: async (): Promise<string> => {
    slowEntries += 1;
    await new Promise<void>((resolve) => {
      releaseSlow = () => resolve();
    });
    return "released";
  },
};

/** Wait until the slow tool has been entered, so a turn is genuinely running. */
async function waitForSlowEntry(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (slowEntries === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (slowEntries === 0) throw new Error("the slow tool was never entered");
}

describe("one conversation, one agent", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
    releaseSlow = undefined;
    slowEntries = 0;
  });

  afterEach(async () => {
    releaseSlow?.();
    if (t) await t.stop();
    t = undefined;
  });

  /** Two personas on two routes, each dispatching by the id in the message. */
  function routes(): RouteDefinition[] {
    return [
      ...craft()
        .id("to-max")
        .input({ body: ChatMessage })
        .from(direct())
        .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
        .to(spy())
        .build(),
      ...craft()
        .id("to-zoe")
        .input({ body: ChatMessage })
        .from(direct())
        .to(agent<ChatMessage>("zoe", { session: (ex) => ex.body.session }))
        .to(spy())
        .build(),
    ];
  }

  async function boot(store?: SessionStore): Promise<TestContext> {
    return testContext()
      .with({
        deferral: { store: new MemoryDeferralStore() },
        sessions: { store: store ?? new MemorySessionStore() },
        shutdown: { timeout: 500 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { slow: slowFn } }),
          agentPlugin({
            agents: {
              max: {
                description: "Max",
                model: SONNET,
                models: [SONNET, HAIKU],
                system: "be Max",
                tools: tools(["slow"]),
                user: (ex) => (ex.body as ChatMessage).message,
              },
              zoe: {
                description: "Zoe",
                model: HAIKU,
                system: "be Zoe",
                user: (ex) => (ex.body as ChatMessage).message,
              },
            },
          }),
        ],
      })
      .routes(routes())
      .build();
  }

  function send(
    ctx: TestContext,
    route: "to-max" | "to-zoe",
    body: ChatMessage,
  ): Promise<AgentResult> {
    return ctx.client.sendDirect(route, body) as Promise<AgentResult>;
  }

  /**
   * @case A second persona dispatched at somebody else's conversation is refused, not served
   * @preconditions One session id answered by max, then the same id dispatched at the route that runs zoe
   * @expectedResult The hazard is reachable (zoe answers that id perfectly well when it is her own conversation) and the collision is refused with RC5003 naming both personas, leaving max's transcript as the only thing in the record
   */
  test("a dispatch naming another persona is refused", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);

    llm.script.push({ text: "max here" }, { text: "zoe here" });
    await send(t, "to-max", { session: "shared", message: "hello" });

    // Reachable: zoe runs, and runs this same route, when the id is hers.
    await send(t, "to-zoe", { session: "zoes-own", message: "hello" });
    expect((await runtime.store.load("zoes-own"))?.agent).toBe("zoe");

    await expect(
      send(t, "to-zoe", { session: "shared", message: "hello again" }),
    ).rejects.toThrow(/belongs to "max" and this dispatch names "zoe"/);

    const record = await runtime.store.load("shared");
    expect(record?.agent).toBe("max");
    // Nothing of zoe's reached the transcript: one user message, one reply.
    expect(record?.messages).toHaveLength(2);
    expect(record?.turns).toBe(1);
  });

  /**
   * @case The agent on the record survives everything a conversation goes through
   * @preconditions One session under max taken through a completed turn, a turn whose provider throws, an interrupt while a turn is running, and a further completed turn
   * @expectedResult The record still names max at every step. The runtime exposes no way to change it, so what is asserted here is that nothing incidental does: a failed turn keeps a partial transcript and counts no turn, an interrupted one keeps what it reached, and neither touches the field
   */
  test("the agent on the record survives turns, failure and interrupt", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "lifelong";

    llm.script.push({ text: "max here" });
    await send(t, "to-max", { session, message: "hello" });
    expect((await runtime.store.load(session))?.agent).toBe("max");

    // A turn that throws: nothing scripted, so the provider fails.
    await expect(
      send(t, "to-max", { session, message: "again" }),
    ).rejects.toThrow();
    const failed = await runtime.store.load(session);
    expect(failed?.agent).toBe("max");
    // The hazard the old turn-count lock missed is still reachable: a
    // failed turn leaves a transcript and counts nothing.
    expect(failed?.turns).toBe(1);
    expect(failed?.messages.length).toBeGreaterThan(2);

    // A turn cut short by an interrupt, which is the editor's cancel: it
    // keeps what it reached and the field is not among the things it
    // touches.
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "after" });
    const running = send(t, "to-max", { session, message: "third" });
    await waitForSlowEntry();
    expect(runtime.interrupt(session, "max")).toBe(true);
    releaseSlow?.();
    await running.catch(() => undefined);
    expect((await runtime.store.load(session))?.agent).toBe("max");

    llm.script.push({ text: "max again" });
    await send(t, "to-max", { session, message: "fourth" });
    expect((await runtime.store.load(session))?.agent).toBe("max");
  });

  /**
   * @case A conversation opened under one agent cannot be adopted by another through any runtime path
   * @preconditions A session opened under max with nothing said, which is the state the old design allowed a change in
   * @expectedResult A dispatch naming zoe is refused even here, so the rule is the record's rather than the transcript's. There is no setAgent to try: `write()` is the only door and it refuses on the field alone
   */
  test("an empty conversation is still its agent's", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "empty";

    await runtime.open(session, "max", { owner: null });
    const before = await runtime.store.load(session);
    expect(before?.agent).toBe("max");
    expect(before?.messages).toHaveLength(0);
    expect(before?.turns).toBe(0);

    llm.script.push({ text: "zoe here" });
    await expect(
      send(t, "to-zoe", { session, message: "hello" }),
    ).rejects.toThrow(/belongs to "max" and this dispatch names "zoe"/);

    const after = await runtime.store.load(session);
    expect(after?.agent).toBe("max");
    expect(after?.messages).toHaveLength(0);
  });

  /**
   * @case Overrides chosen under one agent are never carried to another
   * @preconditions A conversation on max with a model chosen from what max advertises, then a dispatch naming zoe
   * @expectedResult The dispatch is refused and max keeps its own choice. Under the old design this was a clearing rule on the change; with no change to make, the property is that zoe never sees max's record at all
   */
  test("a model chosen under one agent never reaches another", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "chosen";

    await runtime.open(session, "max", { owner: null });
    await runtime.configure(session, "max", { model: HAIKU });

    llm.script.push({ text: "zoe here" });
    await expect(
      send(t, "to-zoe", { session, message: "hello" }),
    ).rejects.toThrow(/belongs to "max"/);

    const record = await runtime.store.load(session);
    expect(record?.agent).toBe("max");
    expect(record?.overrides).toEqual({ model: HAIKU });
  });
});
