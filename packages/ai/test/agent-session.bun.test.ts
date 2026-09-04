import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  DefaultExchange,
  HeadersKeys,
  MemorySuspensionStore,
  craft,
  direct,
  noop,
  type Principal,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  llmPlugin,
  tools,
  type AgentResult,
  type FnHandlerContext,
} from "../src/index.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import {
  AgentSessionStore,
  sessionRecordId,
} from "../src/agent/session/store.ts";
import { INTERRUPTED_TOOL_MESSAGE } from "../src/agent/run.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** The message shape the chat route accepts. */
const ChatMessage = z.object({
  session: z.string(),
  message: z.string(),
  interrupt: z.boolean().optional(),
});
type ChatMessage = z.infer<typeof ChatMessage>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A tool the test holds open. `release()` lets the call finish; the
 * abort signal rejects it, so an interrupt is observable as the tool
 * being cancelled rather than as the loop waiting it out.
 */
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
      release = () => resolve("slow done");
    }),
};

/** Wait until the slow tool is genuinely running, bounded. */
async function waitForEntry(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (entered < count && Date.now() < deadline) await sleep(5);
  if (entered < count) throw new Error(`slow tool entry ${count} never came`);
}

function routes(sink: ReturnType<typeof spy>): RouteDefinition[] {
  return [
    ...craft()
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(
        agent<ChatMessage>("max", {
          session: (ex) => ex.body.session,
          interrupt: (ex) => ex.body.interrupt === true,
        }),
      )
      .to(sink)
      .build(),
    ...craft().id("plain").from(direct()).to(agent("max")).to(noop()).build(),
    ...craft()
      .id("inline")
      .input({ body: ChatMessage })
      .from(direct())
      .to(
        agent<ChatMessage>({
          model: MODEL,
          system: "be useful",
          user: (ex) => ex.body.message,
          tools: tools(["slow"]),
          session: (ex) => ex.body.session,
          interrupt: (ex) => ex.body.interrupt === true,
        }),
      )
      .to(sink)
      .build(),
  ];
}

function contextWith(
  store: MemorySuspensionStore,
  sink: ReturnType<typeof spy>,
): ReturnType<ReturnType<typeof testContext>["routes"]> {
  return testContext()
    .with({
      suspension: { store },
      shutdown: { timeout: 500 },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({
          functions: { slow: slowFn },
          agents: {
            max: {
              description: "Max",
              model: MODEL,
              system: "be useful",
              user: (ex) => (ex.body as ChatMessage).message,
              tools: tools(["slow"]),
            },
          },
        }),
      ],
    })
    .routes(routes(sink));
}

/** The last user message of a recorded model call, as the SDK saw it. */
function lastUserOf(call: { user: unknown }): {
  role: string;
  content: unknown;
} {
  const thread = call.user as Array<{ role: string; content: unknown }>;
  expect(Array.isArray(thread)).toBe(true);
  const users = thread.filter((m) => m.role === "user");
  return users[users.length - 1]!;
}

function send(
  t: TestContext,
  body: ChatMessage,
  as?: string,
): Promise<AgentResult> {
  const principal: Principal | undefined =
    as === undefined
      ? undefined
      : { kind: "custom", scheme: "test", subject: as };
  return t.client.sendDirect(
    "chat",
    body,
    principal === undefined ? {} : { [HeadersKeys.AUTH_PRINCIPAL]: principal },
  ) as Promise<AgentResult>;
}

describe("agent sessions", () => {
  let t: TestContext | undefined;
  let b: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
    release = undefined;
    entered = 0;
  });

  afterEach(async () => {
    release?.();
    if (t) await t.stop();
    if (b) await b.stop();
    t = b = undefined;
  });

  /**
   * @case Two messages to one session run serially and the second turn's context carries the first turn's reply
   * @preconditions One registered agent, one session id, two dispatches awaited one after the other
   * @expectedResult The second model call's thread contains the first user message and the first assistant reply before the second user message, and each result reports status "replied"
   */
  test("the second turn sees the first turn's reply", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "hello alice" });
    const first = await send(t, { session: "s1", message: "I am Alice" });
    expect(first.text).toBe("hello alice");
    expect(first.session).toMatchObject({
      agent: "max",
      id: "s1",
      status: "replied",
      queued: 0,
    });

    llm.script.push({ text: "you are alice" });
    const second = await send(t, { session: "s1", message: "who am I?" });
    expect(second.text).toBe("you are alice");

    expect(llm.calls).toHaveLength(2);
    const thread = llm.calls[1]!.user as Array<{
      role: string;
      content: unknown;
    }>;
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(thread)).toContain("I am Alice");
    expect(JSON.stringify(thread)).toContain("hello alice");
    expect(lastUserOf(llm.calls[1]!).content).toBe("who am I?");
    // The model is told which conversation it is in.
    expect(llm.calls[1]!.system).toContain('session "s1" of agent "max"');
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Two different sessions never see each other's transcript
   * @preconditions The same two messages sent to sessions "a" and "b" on one agent
   * @expectedResult Session b's first turn starts from an empty transcript: its model call carries only its own user message
   */
  test("sessions are isolated from each other", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "hi a" });
    await send(t, { session: "a", message: "I am Alice" });
    llm.script.push({ text: "hi b" });
    await send(t, { session: "b", message: "who am I?" });

    const threadB = llm.calls[1]!.user;
    expect(threadB).toEqual([{ role: "user", content: "who am I?" }]);
    expect(JSON.stringify(threadB)).not.toContain("Alice");
  });

  /**
   * @case A message posted while a turn is running is acknowledged, not answered, and becomes the next turn's first user message
   * @preconditions Turn one is held open by the slow tool; three messages are posted while it runs, then the tool is released
   * @expectedResult Each of the three returns status "queued" with an empty text and a growing depth; when turn one ends the runtime starts turn two on its own, whose first user message is one message with exactly three text parts in arrival order. With the one-turn-at-a-time bound removed this fails: the three messages start their own turns and no call carries three parts
   */
  test("messages during a turn queue and arrive together in order", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    const queued: unknown[] = [];
    t.ctx.on("route:agent:session:queued", ({ details }) => {
      queued.push(details);
    });

    llm.script.push(
      { toolCalls: [{ toolName: "slow" }] },
      { text: "turn one" },
    );
    const first = send(t, { session: "s", message: "start" });
    await waitForEntry(1);

    const one = await send(t, { session: "s", message: "one" });
    const two = await send(t, { session: "s", message: "two" });
    const three = await send(t, { session: "s", message: "three" });
    expect([one, two, three].map((r) => r.text)).toEqual(["", "", ""]);
    expect([one, two, three].map((r) => r.session?.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    expect([one, two, three].map((r) => r.session?.queued)).toEqual([1, 2, 3]);
    expect(queued).toHaveLength(3);
    // Still one model call: nothing started a second turn.
    expect(llm.calls).toHaveLength(1);

    llm.script.push({ text: "turn two" });
    release!();
    const result = await first;
    expect(result.text).toBe("turn one");
    expect(result.session?.queued).toBe(3);

    // The boundary turn runs on its own; wait for its model call.
    const deadline = Date.now() + 5_000;
    while (llm.calls.length < 2 && Date.now() < deadline) await sleep(5);
    expect(llm.calls).toHaveLength(2);
    const user = lastUserOf(llm.calls[1]!);
    expect(user.content).toEqual([
      { type: "text", text: "[Message from an anonymous caller]\none" },
      { type: "text", text: "[Message from an anonymous caller]\ntwo" },
      { type: "text", text: "[Message from an anonymous caller]\nthree" },
    ]);
    // Turn two's thread carries turn one in full.
    expect(JSON.stringify(llm.calls[1]!.user)).toContain("turn one");
    await t.ctx.getRouteById("chat")!.drain();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const summary = await runtime.summary({ agent: "max", session: "s" });
    expect(summary).toMatchObject({ turn: "idle", inbox: 0, turns: 2 });
  });

  /**
   * @case interrupt: true during a long tool call cancels the tool, keeps the partial transcript, and starts the next turn with the queued messages plus the interrupting one
   * @preconditions Turn one is held in the slow tool; one plain message is queued, then a message with interrupt: true is sent
   * @expectedResult The slow tool sees its abort signal, turn one's caller gets status "interrupted" with empty text, the interrupter gets turn two's reply, and turn two's thread holds the interrupted tool call answered with an error result followed by one user message whose parts are the queued message then the interrupting one
   */
  test("interrupt cancels the running tool and keeps what it was doing", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    const interrupted: unknown[] = [];
    t.ctx.on("route:agent:session:interrupted", ({ details }) => {
      interrupted.push(details);
    });

    llm.script.push({ toolCalls: [{ toolName: "slow" }] });
    const first = send(t, { session: "s", message: "build it" });
    await waitForEntry(1);
    const queued = await send(t, { session: "s", message: "also this" });
    expect(queued.session?.status).toBe("queued");

    llm.script.push({ text: "stopped, what now?" });
    const reply = await send(t, {
      session: "s",
      message: "stop",
      interrupt: true,
    });
    expect(reply.text).toBe("stopped, what now?");
    expect(reply.session?.status).toBe("replied");
    expect(llm.sawAbort()).toBe(true);
    expect(interrupted).toHaveLength(1);

    const cancelled = await first;
    expect(cancelled.text).toBe("");
    expect(cancelled.session?.status).toBe("interrupted");

    expect(llm.calls).toHaveLength(2);
    const thread = llm.calls[1]!.user as Array<{
      role: string;
      content: unknown;
    }>;
    expect(thread.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    // The interrupted call is in the thread with an error result: the
    // tool's own abort error when the step finished before the abort
    // surfaced (what the SDK does), or the runtime's interrupted marker
    // when it did not.
    const toolMessage = thread[2] as {
      content: Array<{ toolName: string; output: { type: string } }>;
    };
    expect(toolMessage.content).toEqual([
      expect.objectContaining({
        toolName: "slow",
        output: expect.objectContaining({ type: "error-text" }),
      }),
    ]);
    expect(lastUserOf(llm.calls[1]!).content).toEqual([
      { type: "text", text: "[Message from an anonymous caller]\nalso this" },
      { type: "text", text: "[Message from an anonymous caller]\nstop" },
    ]);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A context stopped with a non-empty inbox, then a new context over the same store: the next turn consumes the inbox
   * @preconditions Context A posts two inbox entries to an idle session through the runtime and stops; context B is built over the same store
   * @expectedResult B's first turn for the session starts with one user message carrying the two queued parts and then the new message. With the durable inbox write removed this fails: B sees only the new message
   */
  test("an inbox survives a restart and is consumed by the next turn", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "ok" });
    await send(t, { session: "s", message: "first" });
    const runtimeA = AgentSessionRuntime.for(t.ctx);
    await runtimeA.post(
      { agent: "max", session: "s" },
      { kind: "message", content: "preview is up", by: "ci" },
    );
    await runtimeA.post(
      { agent: "max", session: "s" },
      { kind: "message", content: "tests passed", by: "ci" },
    );
    expect(
      (await runtimeA.summary({ agent: "max", session: "s" }))?.inbox,
    ).toBe(2);
    await t.stop();
    t = undefined;

    b = await contextWith(store, spy()).build();
    await b.startAndWaitReady();
    llm.script.push({ text: "caught up" });
    const result = await send(b, { session: "s", message: "anything new?" });
    expect(result.text).toBe("caught up");
    expect(lastUserOf(llm.calls[1]!).content).toEqual([
      { type: "text", text: '[Message from "ci"]\npreview is up' },
      { type: "text", text: '[Message from "ci"]\ntests passed' },
      {
        type: "text",
        text: "[Message from an anonymous caller]\nanything new?",
      },
    ]);
    // Turn one's exchange is in the thread too: the transcript survived.
    expect(JSON.stringify(llm.calls[1]!.user)).toContain('"first"');
    const summary = await AgentSessionRuntime.for(b.ctx).summary({
      agent: "max",
      session: "s",
    });
    expect(summary).toMatchObject({ inbox: 0, turns: 2 });
  });

  /**
   * @case A turn a restart cut short is treated as an interrupt at the next turn
   * @preconditions The stored record carries a turn marker and a thread ending on an unanswered tool call, as a process that died mid-turn leaves it
   * @expectedResult The next turn closes the open call with the interrupted marker, clears the marker, emits route:agent:session:restored, and the model call carries the repaired thread
   */
  test("a stale turn marker is restored as an interrupt", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "ok" });
    await send(t, { session: "s", message: "first" });
    // Forge what a crash mid-tool leaves behind, through the store seam.
    const id = sessionRecordId({ agent: "max", session: "s" });
    const record = MemorySuspensionStore.unsafeRecords(store).get(id)!;
    const state = record.stepState as {
      messages: unknown[];
      turn?: unknown;
      background: unknown[];
    };
    state.messages.push(
      { role: "user", content: "run the build" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-dead",
            toolName: "slow",
            input: {},
          },
        ],
      },
    );
    state.turn = { exchangeId: "dead", startedAt: new Date().toISOString() };
    state.background = [
      {
        handle: "sandbox-run:dead",
        tool: "sandbox-run",
        startedAt: "2026-09-04T00:00:00.000Z",
        by: "alice",
      },
    ];
    const restored: unknown[] = [];
    t.ctx.on("route:agent:session:restored", ({ details }) => {
      restored.push(details);
    });
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "s",
        })
      )?.turn,
    ).toBe("stale");

    llm.script.push({ text: "picking up" });
    const result = await send(t, { session: "s", message: "still there?" });
    expect(result.text).toBe("picking up");
    expect(restored).toEqual([
      expect.objectContaining({
        agentName: "max",
        session: "s",
        lostBackground: 1,
      }),
    ]);
    const thread = llm.calls[1]!.user as Array<{
      role: string;
      content: unknown;
    }>;
    const roles = thread.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);
    const rendered = JSON.stringify(thread);
    expect(rendered).toContain('"toolCallId":"tc-dead"');
    expect(rendered).toContain(INTERRUPTED_TOOL_MESSAGE);
    // The lost background call is reported to the model, not dropped.
    expect(rendered).toContain("sandbox-run:dead");
    expect(rendered).toContain("lost");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Absent session, agent() behaves exactly as before
   * @preconditions The same registered agent dispatched through a route without session
   * @expectedResult The model call is a fresh string prompt with no session block, the result carries no session field, and nothing is written to the store
   */
  test("without session nothing is remembered or stored", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "one" }, { text: "two" });
    const first = (await t.client.sendDirect("plain", {
      message: "a",
    })) as AgentResult;
    const second = (await t.client.sendDirect("plain", {
      message: "b",
    })) as AgentResult;
    expect(first.session).toBeUndefined();
    expect(second.session).toBeUndefined();
    expect(llm.calls[1]!.user).toBe("b");
    expect(llm.calls[1]!.system).not.toContain("## Session");
    expect(MemorySuspensionStore.unsafeRecords(store).size).toBe(0);
  });

  /**
   * @case A session resolving to an empty value is refused
   * @preconditions The route's session resolver returns "" for the exchange
   * @expectedResult The dispatch fails with RC5003 naming "session" and no model call is made
   */
  test("an empty session id is refused with RC5003", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    await expect(send(t, { session: "", message: "x" })).rejects.toMatchObject({
      rc: "RC5003",
    });
    expect(llm.calls).toHaveLength(0);
  });

  /**
   * @case The inline form takes session and interrupt exactly as the by-name form does
   * @preconditions An inline agent({ session, interrupt }) on its own route, keyed by the route id; turn one held in the slow tool
   * @expectedResult A message with interrupt: true cancels the running tool, the interrupter gets the next turn's reply, and turn one's caller gets status "interrupted"
   */
  test("an inline agent can interrupt its session", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] });
    const first = t.client.sendDirect("inline", {
      session: "s",
      message: "build it",
    }) as Promise<AgentResult>;
    await waitForEntry(1);
    llm.script.push({ text: "stopped" });
    const reply = (await t.client.sendDirect("inline", {
      session: "s",
      message: "stop",
      interrupt: true,
    })) as AgentResult;
    expect(reply.text).toBe("stopped");
    expect(reply.session).toMatchObject({ agent: "inline", status: "replied" });
    expect((await first).session?.status).toBe("interrupted");
    expect(llm.sawAbort()).toBe(true);
  });

  /**
   * @case A record written by another release of the package is refused as AI1010, not handed to the provider
   * @preconditions One turn has stored a session record; its version field is then rewritten in the store
   * @expectedResult The next message for the session rejects with AI1010 naming the version, and no model call is made for it
   */
  test("a record at another version is AI1010", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "one" });
    await send(t, { session: "old", message: "a" });
    const record = MemorySuspensionStore.unsafeRecords(store).get(
      sessionRecordId({ agent: "max", session: "old" }),
    )!;
    (record.stepState as { version: number }).version = 0;
    await expect(send(t, { session: "old", message: "b" })).rejects.toThrow(
      /version 0.*version 1/,
    );
    expect(llm.calls).toHaveLength(1);
  });

  /**
   * @case A turn that fails on the store propagates to the caller waiting on it rather than starting another turn against the same fault
   * @preconditions The runtime driven directly: turn one held in its executor, turn two interrupts it, and the store refuses every write after turn two's inbox write landed
   * @expectedResult Both callers reject with the store's error, the executor ran exactly once, and no further turn was started
   */
  test("a failed turn is the waiting caller's answer", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    let writes = 0;
    // Methods are bound to the real store: the class keeps private fields,
    // which a call through the proxy as `this` cannot reach.
    const failing = new Proxy(store, {
      get(target, prop) {
        if (prop === "replaceStepState") {
          return async (...args: unknown[]) => {
            writes += 1;
            if (writes >= 2) throw new Error("store down");
            return (
              target.replaceStepState as (...a: unknown[]) => Promise<unknown>
            ).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = new AgentSessionRuntime(
      t.ctx,
      new AgentSessionStore(failing),
    );
    let runs = 0;
    const executor = {
      run: (_messages: unknown, interrupt: AbortSignal) =>
        new Promise<AgentResult>((_resolve, reject) => {
          runs += 1;
          interrupt.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
      thread: () => undefined,
    };
    const exchange = new DefaultExchange(t.ctx, { body: {} });
    const key = { agent: "max", session: "direct" };
    const first = runtime.turn({
      key,
      exchange,
      message: "a",
      by: "anonymous",
      interrupt: false,
      executor,
    });
    first.catch(() => undefined);
    await sleep(10);
    const second = runtime.turn({
      key,
      exchange,
      message: "b",
      by: "anonymous",
      interrupt: true,
      executor,
    });
    await expect(second).rejects.toThrow(/store down/);
    await expect(first).rejects.toThrow(/store down/);
    expect(runs).toBe(1);
    expect(runtime.isRunning(key)).toBe(false);
  });

  /**
   * @case A queued message is attributed to its poster while the turn that consumes it runs under the exchange that parked
   * @preconditions Alice's turn is held in the slow tool; Bob and an anonymous caller queue a message each; the tool is released and the boundary turn consumes both
   * @expectedResult The delivered user message carries a bracketed attribution per part naming "bob" and an anonymous caller, the stored transcript holds the same, and the exchange the boundary turn ran on carries Alice's principal, not Bob's
   */
  test("a queued message names its poster and runs under the parked exchange", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    t = await contextWith(store, sink).build();
    await t.startAndWaitReady();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "done" });
    const first = send(t, { session: "s", message: "start" }, "alice");
    await waitForEntry(1);
    const bob = await send(t, { session: "s", message: "bob says hi" }, "bob");
    expect(bob.session?.status).toBe("queued");
    const anon = await send(t, { session: "s", message: "who is there?" });
    expect(anon.session?.status).toBe("queued");
    llm.script.push({ text: "hello both" });
    release!();
    await first;
    const deadline = Date.now() + 5_000;
    while (llm.calls.length < 2 && Date.now() < deadline) await sleep(5);
    await t.ctx.getRouteById("chat")!.drain();
    expect(lastUserOf(llm.calls[1]!).content).toEqual([
      { type: "text", text: '[Message from "bob"]\nbob says hi' },
      {
        type: "text",
        text: "[Message from an anonymous caller]\nwho is there?",
      },
    ]);
    const record = MemorySuspensionStore.unsafeRecords(store).get(
      sessionRecordId({ agent: "max", session: "s" }),
    )!;
    expect(JSON.stringify(record.stepState)).toContain(
      '[Message from \\"bob\\"]',
    );
    // The boundary turn ran on Alice's parked exchange: its downstream
    // delivery carries her principal, whoever queued the text.
    const boundary = sink.received[sink.received.length - 1]!;
    expect((boundary.body as AgentResult).text).toBe("hello both");
    expect(boundary.principal?.subject).toBe("alice");
  });

  /**
   * @case The session records who started it, and a later caller does not change that
   * @preconditions Alice's message starts the session; Bob's message runs the next turn
   * @expectedResult The summary reports startedBy "alice" after both turns, and Bob's own message, having started its turn, is delivered as a plain string under his turn
   */
  test("the session records its starter", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ text: "hi alice" }, { text: "hi bob" });
    await send(t, { session: "s", message: "I am Alice" }, "alice");
    await send(t, { session: "s", message: "I am Bob" }, "bob");
    expect(lastUserOf(llm.calls[1]!).content).toBe("I am Bob");
    const summary = await AgentSessionRuntime.for(t.ctx).summary({
      agent: "max",
      session: "s",
    });
    expect(summary).toMatchObject({ startedBy: "alice", turns: 2 });
    llm.script.push({ text: "hi nobody" });
    await send(t, { session: "anon", message: "hello" });
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "anon",
        })
      )?.startedBy,
    ).toBe("anonymous");
  });

  /**
   * @case A context without a suspension block cannot host sessions
   * @preconditions The same routes built on a context that declares no suspension config
   * @expectedResult The dispatch fails with RC5052 naming the suspension block
   */
  test("a session needs the suspension store", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              max: { description: "Max", model: MODEL, system: "x" },
            },
          }),
        ],
      })
      .routes(routes(spy()))
      .build();
    await t.startAndWaitReady();
    await expect(send(t, { session: "s", message: "x" })).rejects.toMatchObject(
      {
        rc: "RC5052",
      },
    );
  });
});
