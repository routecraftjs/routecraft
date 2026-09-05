import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  noop,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  AgentHeadersKeys,
  type AgentResult,
  type BackgroundToolHandle,
  type FnHandlerContext,
} from "../src/index.ts";
import { MemorySessionStore } from "../src/agent/session/index.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;
const RunInput = z.object({ cmd: z.string() });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The long route is held here until the test lets it finish. */
let release: ((value: string) => void) | undefined;
let finished = false;

function routes(
  sink: ReturnType<typeof spy>,
  chatSink: ReturnType<typeof spy>,
): RouteDefinition[] {
  return [
    ...craft()
      .id("sandbox-run")
      .description("Run a command in a container")
      .input({ body: RunInput })
      .from(direct())
      .transform(async (body) => {
        const stdout = await new Promise<string>((resolve) => {
          release = resolve;
        });
        finished = true;
        return { stdout, cmd: body.cmd };
      })
      .to(sink)
      .build(),
    ...craft()
      .id("broken-run")
      .description("Always fails")
      .input({ body: RunInput })
      .from(direct())
      .transform(() => {
        throw new Error("the build host is gone");
      })
      .to(noop())
      .build(),
    ...craft()
      .id("odd-run")
      .description("Answers with a value JSON cannot hold")
      .input({ body: RunInput })
      .from(direct())
      .transform(() => ({ size: 1n }))
      .to(noop())
      .build(),
    ...craft()
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
      .to(chatSink)
      .build(),
    ...craft().id("plain").from(direct()).to(agent("max")).to(noop()).build(),
  ];
}

const whoami = {
  description: "Which session am I in",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) => ctx.session ?? null,
};

/** The session store paired with a suspension store, so a restart over the same stores sees the same sessions. */
const recordStores = new WeakMap<MemorySuspensionStore, MemorySessionStore>();
function recordsFor(store: MemorySuspensionStore): MemorySessionStore {
  let records = recordStores.get(store);
  if (!records) {
    records = new MemorySessionStore();
    recordStores.set(store, records);
  }
  return records;
}

function contextWith(
  store: MemorySuspensionStore,
  sink: ReturnType<typeof spy>,
  chatSink: ReturnType<typeof spy> = spy(),
): ReturnType<ReturnType<typeof testContext>["routes"]> {
  return testContext()
    .with({
      suspension: { store },
      sessions: { store: recordsFor(store) },
      shutdown: { timeout: 500 },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({
          functions: {
            sandboxRun: directTool("sandbox-run", { background: true }),
            brokenRun: directTool("broken-run", { background: true }),
            oddRun: directTool("odd-run", { background: true }),
            whoami,
          },
          agents: {
            max: {
              description: "Max",
              model: MODEL,
              system: "be useful",
              user: (ex) => (ex.body as ChatMessage).message,
              tools: tools(["sandboxRun", "brokenRun", "oddRun", "whoami"]),
            },
          },
        }),
      ],
    })
    .routes(routes(sink, chatSink));
}

/** Wait, bounded, until the scripted model has been called `count` times. */
async function waitForCalls(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (llm.calls.length < count && Date.now() < deadline) await sleep(5);
  if (llm.calls.length < count) {
    throw new Error(`model call ${count} never came`);
  }
}

function send(t: TestContext, body: ChatMessage): Promise<AgentResult> {
  return t.client.sendDirect("chat", body) as Promise<AgentResult>;
}

/** The last user message of a recorded model call, as the SDK saw it. */
function lastUserOf(call: { user: unknown }): unknown {
  const thread = call.user as Array<{ role: string; content: unknown }>;
  const users = thread.filter((m) => m.role === "user");
  return users[users.length - 1]!.content;
}

describe("background tools", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
    release = undefined;
    finished = false;
  });

  afterEach(async () => {
    release?.("released at teardown");
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A background call returns a handle at once, the turn replies before the route finishes, and the completion starts the next turn on its own
   * @preconditions sandbox-run is held open by the test; the agent calls it and answers; the route is released after the reply, and no further message is sent
   * @expectedResult The tool result the model saw is { handle: "sandbox-run:<dispatchId>", status: "running" } and the dispatched exchange carries the handle on its headers; the reply arrives while the route is still running and the turn's exchange is parked with one background call; once released, background:completed is emitted, the stored continuation is revived and a second model call is made with no new message, whose only user part carries the result text naming the handle; that turn's reply reaches the chat route's downstream step; a later message is a third call carrying only itself. With the revival removed this fails: no second call is made until a message arrives
   */
  test("the turn continues past the call and the completion starts the next turn", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    const chatSink = spy();
    t = await contextWith(store, sink, chatSink).build();
    await t.startAndWaitReady();
    const events: string[] = [];
    for (const name of [
      "route:agent:session:background:started",
      "route:agent:session:background:completed",
      "route:agent:session:parked",
      "route:agent:session:revived",
    ] as const) {
      t.ctx.on(name, () => {
        events.push(name);
      });
    }

    llm.script.push(
      { toolCalls: [{ toolName: "sandboxRun", input: { cmd: "make test" } }] },
      { text: "started the build" },
    );
    const reply = await send(t, { session: "s", message: "run the tests" });
    expect(reply.text).toBe("started the build");
    expect(finished).toBe(false);
    const call = reply.toolCalls?.[0];
    expect(call?.toolName).toBe("sandboxRun");
    const receipt = call?.output as BackgroundToolHandle;
    expect(receipt.status).toBe("running");
    expect(receipt.handle).toMatch(/^sandbox-run:[0-9a-f-]{36}$/);
    expect(events).toEqual([
      "route:agent:session:background:started",
      "route:agent:session:parked",
    ]);
    // The model was told the tool is asynchronous.
    const advertised = (
      llm.calls[0]!.tools as Record<string, { description: string }>
    )["sandboxRun"]!;
    expect(advertised.description).toContain("runs in the background");
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "s",
        })
      )?.background,
    ).toBe(1);
    expect(chatSink.received).toHaveLength(1);

    llm.script.push({ text: "green, opening the PR" });
    release!("all 12 tests passed");
    await waitForCalls(2);
    await t.ctx.getRouteById("chat")!.drain();
    expect(events).toEqual([
      "route:agent:session:background:started",
      "route:agent:session:parked",
      "route:agent:session:background:completed",
      "route:agent:session:revived",
    ]);
    // The run the handle names is findable from the route's side.
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.headers[AgentHeadersKeys.BACKGROUND_HANDLE]).toBe(
      receipt.handle,
    );
    // The completion was the whole of the revived turn's user message.
    const parts = lastUserOf(llm.calls[1]!) as Array<{
      type: string;
      text: string;
    }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain('"sandboxRun" finished');
    expect(parts[0]!.text).toContain("all 12 tests passed");
    // And its reply ran the route's downstream step, on the revived exchange.
    expect(chatSink.received).toHaveLength(2);
    expect((chatSink.received[1]!.body as AgentResult).text).toBe(
      "green, opening the PR",
    );
    expect((chatSink.received[1]!.body as AgentResult).session).toMatchObject({
      status: "replied",
      queued: 0,
    });
    const summary = await AgentSessionRuntime.for(t.ctx).summary({
      agent: "max",
      session: "s",
    });
    expect(summary).toMatchObject({ background: 0, inbox: 0, turns: 2 });

    llm.script.push({ text: "yes" });
    const next = await send(t, { session: "s", message: "and?" });
    expect(next.text).toBe("yes");
    expect(lastUserOf(llm.calls[2]!)).toBe("and?");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A process that dies with a background call outstanding: the next process reports the run lost and the loss starts a turn on its own
   * @preconditions Context A's turn calls sandbox-run, which is never released, replies, and A stops; context B is built over the same store and no message is sent
   * @expectedResult B's boot revives the stored continuation with the lost-run message as the turn's user message, the model is called once with it, the reply reaches the chat route's downstream step, and the session reports no background calls. With the boot drive removed this fails: no call is made until a message arrives
   */
  test("a lost run reaches the model at the next boot", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push(
      { toolCalls: [{ toolName: "sandboxRun", input: { cmd: "make" } }] },
      { text: "building" },
    );
    const reply = await send(t, { session: "s", message: "build it" });
    const receipt = reply.toolCalls?.[0]?.output as BackgroundToolHandle;
    await t.stop();
    t = undefined;

    const chatSink = spy();
    llm.script.push({ text: "the build was lost, starting it again" });
    t = await contextWith(store, spy(), chatSink).build();
    await t.startAndWaitReady();
    await waitForCalls(2);
    await t.ctx.getRouteById("chat")!.drain();
    const parts = lastUserOf(llm.calls[1]!) as Array<{ text: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain('"sandboxRun" failed');
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain("process restarted");
    expect(chatSink.received).toHaveLength(1);
    expect((chatSink.received[0]!.body as AgentResult).text).toBe(
      "the build was lost, starting it again",
    );
    expect(
      await AgentSessionRuntime.for(t.ctx).summary({
        agent: "max",
        session: "s",
      }),
    ).toMatchObject({ background: 0, inbox: 0, turn: "idle" });
  });

  /**
   * @case A background route that fails posts its failure to the inbox, attributed to the handle, and the boundary delivers it
   * @preconditions broken-run throws at once, so the failure lands while the calling turn is still running
   * @expectedResult background:failed is emitted, the reply reports one queued message, and the turn the boundary starts on its own opens with a user message saying the tool failed, naming the handle and carrying the error message
   */
  test("a failing route posts a failure the model can read", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    const failed: unknown[] = [];
    t.ctx.on("route:agent:session:background:failed", ({ details }) => {
      failed.push(details);
    });
    llm.script.push(
      { toolCalls: [{ toolName: "brokenRun", input: { cmd: "x" } }] },
      { text: "started" },
      { text: "retrying" },
    );
    const reply = await send(t, { session: "s", message: "go" });
    const receipt = reply.toolCalls?.[0]?.output as BackgroundToolHandle;
    expect(reply.session?.queued).toBe(1);
    expect(failed).toEqual([
      expect.objectContaining({
        handle: receipt.handle,
        toolName: "brokenRun",
        errorName: "RoutecraftError",
      }),
    ]);
    const deadline = Date.now() + 5_000;
    while (llm.calls.length < 2 && Date.now() < deadline) await sleep(5);
    await t.ctx.getRouteById("chat")!.drain();
    const parts = lastUserOf(llm.calls[1]!) as Array<{ text: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain('"brokenRun" failed');
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain("the build host is gone");
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "s",
        })
      )?.background,
    ).toBe(0);
  });

  /**
   * @case A background result the record cannot hold is delivered as a failure, and the call is retired
   * @preconditions odd-run answers with a BigInt, which JSON refuses; the agent calls it and replies
   * @expectedResult The boundary turn opens with a user message saying the tool failed, naming the handle and the encoding reason, and no background call remains
   */
  test("a result the store cannot hold is reported, not stuck", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push(
      { toolCalls: [{ toolName: "oddRun", input: { cmd: "size" } }] },
      { text: "started" },
      { text: "noted" },
    );
    const reply = await send(t, { session: "s", message: "go" });
    const receipt = reply.toolCalls?.[0]?.output as BackgroundToolHandle;
    await waitForCalls(2);
    await t.ctx.getRouteById("chat")!.drain();
    const parts = lastUserOf(llm.calls[1]!) as Array<{ text: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain('"oddRun" failed');
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain("could not be stored");
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "s",
        })
      )?.background,
    ).toBe(0);
  });

  /**
   * @case A background tool on a sessionless agent is refused when the tool list is resolved
   * @preconditions The same agent dispatched through a route without session
   * @expectedResult The dispatch fails with RC5003 naming the background tool, and no model call is made
   */
  test("a sessionless agent cannot carry a background tool", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("plain", { message: "hi" }),
    ).rejects.toMatchObject({ rc: "RC5003" });
    await expect(
      t.client.sendDirect("plain", { message: "hi" }),
    ).rejects.toThrow(/sandboxRun.*background: true/);
    expect(llm.calls).toHaveLength(0);
  });

  /**
   * @case A tool handler is told which session it runs in
   * @preconditions A plain fn returns ctx.session; the agent calls it inside a session turn
   * @expectedResult Inside the session the tool sees { agent: "max", id: "s" }; the handle context is frozen
   */
  test("ctx.session names the calling session", async () => {
    const store = new MemorySuspensionStore();
    t = await contextWith(store, spy()).build();
    await t.startAndWaitReady();
    llm.script.push({ toolCalls: [{ toolName: "whoami" }] }, { text: "ok" });
    const reply = await send(t, { session: "s", message: "who?" });
    expect(reply.toolCalls?.[0]?.output).toEqual({ agent: "max", id: "s" });
    expect(Object.isFrozen(reply.toolCalls?.[0]?.output)).toBe(true);
  });
});
