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

function routes(sink: ReturnType<typeof spy>): RouteDefinition[] {
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
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
      .to(noop())
      .build(),
    ...craft().id("plain").from(direct()).to(agent("max")).to(noop()).build(),
  ];
}

const whoami = {
  description: "Which session am I in",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) => ctx.session ?? null,
};

function contextWith(
  store: MemorySuspensionStore,
  sink: ReturnType<typeof spy>,
): ReturnType<ReturnType<typeof testContext>["routes"]> {
  return testContext()
    .with({
      suspension: { store },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({
          functions: {
            sandboxRun: directTool("sandbox-run", { background: true }),
            brokenRun: directTool("broken-run", { background: true }),
            whoami,
          },
          agents: {
            max: {
              description: "Max",
              model: MODEL,
              system: "be useful",
              user: (ex) => (ex.body as ChatMessage).message,
              tools: tools(["sandboxRun", "brokenRun", "whoami"]),
            },
          },
        }),
      ],
    })
    .routes(routes(sink));
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

async function inboxDepth(t: TestContext, session: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const summary = await AgentSessionRuntime.for(t.ctx).summary({
      agent: "max",
      session,
    });
    if (summary && summary.inbox > 0) return summary.inbox;
    if (Date.now() > deadline) return summary?.inbox ?? 0;
    await sleep(5);
  }
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
   * @case A background call returns a handle at once, the turn replies before the route finishes, and the next turn opens with the result attributed to the handle
   * @preconditions sandbox-run is held open by the test; the agent calls it and answers; the route is released after the reply
   * @expectedResult The tool result the model saw is { handle: "sandbox-run:<dispatchId>", status: "running" } and the dispatched exchange carries the handle on its headers; the reply arrives while the route is still running; once released the result lands in the inbox with background:started and :completed emitted; the next turn's first user message carries the result text naming the handle before the new message. With the inbox post removed this fails: the next turn carries only the new message
   */
  test("the turn continues past the call and the next turn opens with the result", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    t = await contextWith(store, sink).build();
    await t.startAndWaitReady();
    const events: string[] = [];
    for (const name of [
      "route:agent:session:background:started",
      "route:agent:session:background:completed",
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
    expect(events).toEqual(["route:agent:session:background:started"]);
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

    release!("all 12 tests passed");
    expect(await inboxDepth(t, "s")).toBe(1);
    expect(events).toEqual([
      "route:agent:session:background:started",
      "route:agent:session:background:completed",
    ]);
    // The run the handle names is findable from the route's side.
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.headers[AgentHeadersKeys.BACKGROUND_HANDLE]).toBe(
      receipt.handle,
    );

    llm.script.push({ text: "green" });
    const next = await send(t, { session: "s", message: "and?" });
    expect(next.text).toBe("green");
    const parts = lastUserOf(llm.calls[1]!) as Array<{
      type: string;
      text: string;
    }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain('"sandboxRun" finished');
    expect(parts[0]!.text).toContain("all 12 tests passed");
    expect(parts[1]).toEqual({ type: "text", text: "and?" });
    expect(
      (
        await AgentSessionRuntime.for(t.ctx).summary({
          agent: "max",
          session: "s",
        })
      )?.background,
    ).toBe(0);
    expect(t.errors).toHaveLength(0);
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
   * @preconditions A plain fn returns ctx.session; the agent calls it inside a session turn and once on the sessionless route without background tools
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
