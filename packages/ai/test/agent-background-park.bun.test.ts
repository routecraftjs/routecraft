import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  HeadersKeys,
  MemoryDeferralStore,
  authorityOf,
  craft,
  direct,
  noop,
  principalOf,
  rcCodeOf,
  type Duration,
  type Principal,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  type AgentPluginOptions,
  type AgentResult,
  type BackgroundToolHandle,
  type ToolsItem,
} from "../src/index.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { recordsFor } from "./helpers/session-stores.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";
import { sleep, until } from "./helpers/until.ts";

const llm = scriptedLlm([]);
/** Shared across the contexts a restart test builds, so a token minted by one verifies on the next. */
const SECRET = "background-park-test-secret-key-0123456789";
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;
const Ask = z.object({ ask: z.string() });
const Decision = z.object({
  verdict: z.enum(["approve", "decline", "fail", "drop"]),
  reason: z.string().optional(),
});
type Decision = z.infer<typeof Decision>;

/** The resume token execution one minted, captured before the park. */
let token = "";
/** How often the parked route's continuation ran. */
let actionRuns = 0;
/** The slow route is held here until the test lets it finish. */
let release: ((value: string) => void) | undefined;

/**
 * A capability that parks for a human and answers the decision as a result:
 * the shape eywa's gated capabilities have, with `fail` and `drop` arms so
 * the two other ways execution two can end are reachable from a resume.
 */
function parkRoute(
  ttl: Duration,
  sink: ReturnType<typeof spy>,
): RouteDefinition[] {
  return craft()
    .id("park")
    .description("Ask a human before acting")
    .input({ body: Ask })
    .from(direct())
    .process((ex) => {
      token = ex.deferral.token;
      return ex;
    })
    .defer({ schema: Decision, ttl })
    .filter((ex) =>
      (ex.deferral.result as Decision).verdict === "drop"
        ? { reason: "the approver withdrew" }
        : true,
    )
    .transform((_body, ex) => {
      actionRuns++;
      const decision = ex.deferral.result as Decision;
      if (decision.verdict === "fail") {
        throw new Error("the mail relay is down");
      }
      return {
        approved: decision.verdict === "approve",
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
    })
    .to(sink)
    .build();
}

function routes(
  sink: ReturnType<typeof spy>,
  chatSink: ReturnType<typeof spy>,
  ttl: Duration = "1h",
): RouteDefinition[] {
  return [
    ...parkRoute(ttl, sink),
    ...craft()
      .id("sandbox")
      .description("A slow route that does not park")
      .input({ body: z.object({ cmd: z.string() }) })
      .from(direct())
      .transform(async (body) => {
        const stdout = await new Promise<string>((resolve) => {
          release = resolve;
        });
        return { stdout, cmd: body.cmd };
      })
      .to(noop())
      .build(),
    ...craft().id("answers").from(direct()).resume().build(),
    ...craft()
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
      .to(chatSink)
      .build(),
  ];
}

interface Setup {
  store: MemoryDeferralStore;
  sink?: ReturnType<typeof spy>;
  chatSink?: ReturnType<typeof spy>;
  /** The agent's tool list; `Direct(park)` with nothing declared by default. */
  tools?: ToolsItem[];
  functions?: AgentPluginOptions["functions"];
  reidentify?: AgentPluginOptions["reidentify"];
  ttl?: Duration;
}

function contextWith(setup: Setup) {
  return testContext()
    .with({
      deferral: { store: setup.store, secret: SECRET },
      sessions: { store: recordsFor(setup.store) },
      shutdown: { timeout: 500 },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({
          ...(setup.functions !== undefined
            ? { functions: setup.functions }
            : {}),
          ...(setup.reidentify !== undefined
            ? { reidentify: setup.reidentify }
            : {}),
          agents: {
            max: {
              description: "Max",
              model: MODEL,
              system: "be useful",
              user: (ex) => (ex.body as ChatMessage).message,
              tools: tools(setup.tools ?? ["Direct(park)"]),
            },
          },
        }),
      ],
    })
    .routes(routes(setup.sink ?? spy(), setup.chatSink ?? spy(), setup.ttl));
}

function send(
  t: TestContext,
  body: ChatMessage,
  principal?: Principal,
): Promise<AgentResult> {
  return t.client.sendDirect(
    "chat",
    body,
    principal === undefined ? {} : { [HeadersKeys.AUTH_PRINCIPAL]: principal },
  ) as Promise<AgentResult>;
}

/** Answer the park, as the human's ingress would. */
function answer(t: TestContext, result: Decision): Promise<unknown> {
  return t.client.sendDirect("answers", { token, result });
}

/** The last user message of a recorded model call, as the SDK saw it. */
function lastUserOf(call: { user: unknown }): Array<{ text: string }> {
  const thread = call.user as Array<{ role: string; content: unknown }>;
  const users = thread.filter((m) => m.role === "user");
  return users[users.length - 1]!.content as Array<{ text: string }>;
}

async function summaryOf(t: TestContext, session: string) {
  return (await AgentSessionRuntime.for(t.ctx).summary(session, "operator"))!;
}

async function recordOf(store: MemoryDeferralStore, session: string) {
  return (await recordsFor(store).get(session))!.value as {
    background: Array<{ handle: string; deferralId?: string }>;
    inbox: Array<{
      kind: string;
      handle?: string;
      tool?: string;
      status?: string;
      result?: unknown;
      error?: { rc?: string; message: string };
    }>;
    deferral?: unknown;
  };
}

/** Dispatch one turn that calls the park tool and ends holding its handle. */
async function parkFromTurn(
  t: TestContext,
  toolName: string,
  principal?: Principal,
): Promise<BackgroundToolHandle> {
  llm.script.push(
    { toolCalls: [{ toolName, input: { ask: "may I?" } }] },
    { text: "asked, waiting" },
  );
  const reply = await send(t, { session: "s", message: "go" }, principal);
  const receipt = reply.toolCalls?.[0]?.output as BackgroundToolHandle;
  expect(receipt.status).toBe("running");
  expect(receipt.handle).toMatch(/^park:[0-9a-f-]{36}$/);
  // The park is recorded once the dispatch resolves, after the reply.
  await until(
    async () =>
      (await recordOf(store!, "s")).background[0]?.deferralId !== undefined,
  );
  return receipt;
}

let store: MemoryDeferralStore | undefined;

describe("background tools over a parking route", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
    token = "";
    actionRuns = 0;
    release = undefined;
    store = new MemoryDeferralStore();
  });

  afterEach(async () => {
    release?.("released at teardown");
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A background call over a route that parks stays open on the acknowledgment and settles with execution two's body
   * @preconditions The agent's tool list names Direct(park) with nothing declared; the model calls it; the route parks; the turn ends; the human approves through the resume ingress
   * @expectedResult The tool is background by shape and returns a running handle; the session record keeps the call with the deferralId recorded and no inbox entry; the token reaches neither the model nor the record; once the park is answered the handle settles with the continuation's body, the inbox message names the tool and the handle, the idle session revives, and the next turn's user message carries the decision
   */
  test("the handle stays open through the park and settles from execution two", async () => {
    const sink = spy();
    const chatSink = spy();
    t = await contextWith({ store: store!, sink, chatSink }).build();
    await t.startAndWaitReady();
    const events: string[] = [];
    for (const name of [
      "route:agent:session:background:started",
      "route:agent:session:background:completed",
      "route:agent:session:deferred",
      "route:agent:session:revived",
    ] as const) {
      t.ctx.on(name, () => {
        events.push(name);
      });
    }
    const receipt = await parkFromTurn(t, "direct__park");
    expect(token.length).toBeGreaterThan(0);
    const parked = await recordOf(store!, "s");
    expect(parked.background).toEqual([
      expect.objectContaining({
        handle: receipt.handle,
        tool: "direct__park",
        deferralId: expect.any(String),
      }),
    ]);
    expect(parked.inbox).toHaveLength(0);
    expect(parked.deferral).toBeDefined();
    expect(actionRuns).toBe(0);
    expect(JSON.stringify(llm.calls)).not.toContain(token);
    expect(JSON.stringify(parked)).not.toContain(token);
    expect(events).toEqual([
      "route:agent:session:background:started",
      "route:agent:session:deferred",
    ]);

    llm.script.push({ text: "approved, proceeding" });
    await answer(t, { verdict: "approve", reason: "looks fine" });
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    expect(actionRuns).toBe(1);
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.body).toEqual({
      approved: true,
      reason: "looks fine",
    });
    const parts = lastUserOf(llm.calls[1]!);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain(`Handle: ${receipt.handle}`);
    expect(parts[0]!.text).toContain('"direct__park" finished');
    expect(parts[0]!.text).toContain('"approved":true');
    expect(parts[0]!.text).toContain("looks fine");
    expect(events).toEqual([
      "route:agent:session:background:started",
      "route:agent:session:deferred",
      "route:agent:session:background:completed",
      "route:agent:session:revived",
    ]);
    expect(chatSink.received).toHaveLength(2);
    expect((chatSink.received[1]!.body as AgentResult).text).toBe(
      "approved, proceeding",
    );
    expect(await summaryOf(t, "s")).toMatchObject({
      background: 0,
      inbox: 0,
      turns: 2,
    });
    expect(JSON.stringify(llm.calls)).not.toContain(token);
  });

  /**
   * @case A decline is an ordinary background message the model revises from
   * @preconditions The parked route answers a decline as a result rather than a drop; the human declines with a reason
   * @expectedResult The handle settles completed with the route's own answer, and the revived turn reads the reason beside its original call, so asking again is the next turn
   */
  test("a decline reaches the model as the route's answer", async () => {
    t = await contextWith({ store: store! }).build();
    await t.startAndWaitReady();
    await parkFromTurn(t, "direct__park");
    llm.script.push({ text: "revising" });
    await answer(t, { verdict: "decline", reason: "use opus, not sonnet" });
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    const text = lastUserOf(llm.calls[1]!)[0]!.text;
    expect(text).toContain('"direct__park" finished');
    expect(text).toContain('"approved":false');
    expect(text).toContain("use opus, not sonnet");
  });

  /**
   * @case Execution two fails or drops, and the handle settles as failed carrying the cause
   * @preconditions The human's answer drives the continuation into a throw, or into a filter that drops with a reason
   * @expectedResult The inbox entry is a failure naming the handle; a thrown error carries its message, a drop carries the drop reason; background:failed is emitted and the revived turn reads it
   */
  test.each([
    ["fail", "the mail relay is down"],
    ["drop", "the approver withdrew"],
  ] as const)(
    "execution two that ends by %s settles the handle as failed",
    async (verdict, cause) => {
      t = await contextWith({ store: store! }).build();
      await t.startAndWaitReady();
      const failed: unknown[] = [];
      t.ctx.on("route:agent:session:background:failed", ({ details }) => {
        failed.push(details);
      });
      const receipt = await parkFromTurn(t, "direct__park");
      llm.script.push({ text: "noted" });
      await answer(t, { verdict }).catch(() => undefined);
      await until(() => llm.calls.length === 2);
      await t.ctx.getRouteById("chat")!.drain();
      const text = lastUserOf(llm.calls[1]!)[0]!.text;
      expect(text).toContain('"direct__park" failed');
      expect(text).toContain(`Handle: ${receipt.handle}`);
      expect(text).toContain(cause);
      expect(failed).toEqual([
        expect.objectContaining({
          handle: receipt.handle,
          toolName: "direct__park",
        }),
      ]);
      expect(await summaryOf(t, "s")).toMatchObject({
        background: 0,
        inbox: 0,
      });
    },
  );

  /**
   * @case The park expires before anyone answers
   * @preconditions The parked route's ttl is one millisecond; a late answer arrives at the resume ingress, which is what retires an overdue deferral and fires route:exchange:expired with no exchange snapshot
   * @expectedResult The handle settles as failed with RC5047, found through the deferralId the park recorded on the session record, and the revived turn reads the expiry
   */
  test("an expired park settles the handle with RC5047", async () => {
    t = await contextWith({ store: store!, ttl: "1ms" }).build();
    await t.startAndWaitReady();
    const receipt = await parkFromTurn(t, "direct__park");
    await sleep(5);
    llm.script.push({ text: "asking again" });
    const late = await answer(t, { verdict: "approve" }).catch(
      (err: unknown) => err,
    );
    expect(rcCodeOf(late)).toBe("RC5047");
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    const text = lastUserOf(llm.calls[1]!)[0]!.text;
    expect(text).toContain('"direct__park" failed');
    expect(text).toContain(`Handle: ${receipt.handle}`);
    expect(text).toContain("RC5047");
    expect(actionRuns).toBe(0);
    expect(await summaryOf(t, "s")).toMatchObject({ background: 0, inbox: 0 });
  });

  /**
   * @case The process restarts between the park and the decision
   * @preconditions Context A parks and stops; context B is built over the same stores, and the human answers on B
   * @expectedResult B's boot does not report the parked call lost; the answer on B settles the handle from execution two, revives the continuation, and the model's next turn carries the decision, because the handle rides the stored exchange and the deferralId rides the session record
   */
  test("a park outlives the process that opened it", async () => {
    t = await contextWith({ store: store! }).build();
    await t.startAndWaitReady();
    const receipt = await parkFromTurn(t, "direct__park");
    await t.stop();
    t = undefined;

    const chatSink = spy();
    t = await contextWith({ store: store!, chatSink }).build();
    await t.startAndWaitReady();
    expect(await summaryOf(t, "s")).toMatchObject({
      background: 1,
      inbox: 0,
      deferred: true,
    });
    llm.script.push({ text: "approved after the restart" });
    await answer(t, { verdict: "approve" });
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    const text = lastUserOf(llm.calls[1]!)[0]!.text;
    expect(text).toContain('"direct__park" finished');
    expect(text).toContain(`Handle: ${receipt.handle}`);
    expect(text).not.toContain("lost");
    expect(chatSink.received).toHaveLength(1);
    expect((chatSink.received[0]!.body as AgentResult).text).toBe(
      "approved after the restart",
    );
    expect(await summaryOf(t, "s")).toMatchObject({ background: 0, inbox: 0 });
  });

  /**
   * @case A running turn sees the settlement at its boundary, as any background result
   * @preconditions The park is answered while a second turn on the session is still running
   * @expectedResult No revival happens under the running turn; the boundary delivers the settlement as the next turn's user message
   */
  test("a running session takes the settlement at its boundary", async () => {
    t = await contextWith({
      store: store!,
      tools: ["Direct(park)", "Direct(sandbox)"],
    }).build();
    await t.startAndWaitReady();
    const receipt = await parkFromTurn(t, "direct__park");
    // A synchronous slow tool holds the second turn open.
    llm.script.push({
      toolCalls: [{ toolName: "direct__sandbox", input: { cmd: "wait" } }],
    });
    const second = send(t, { session: "s", message: "meanwhile" });
    await until(() => release !== undefined);
    await answer(t, { verdict: "approve" });
    await until(async () => (await recordOf(store!, "s")).inbox.length === 1);
    expect(llm.calls).toHaveLength(2);
    llm.script.push({ text: "still here" }, { text: "read the decision" });
    release!("ok");
    expect((await second).session).toMatchObject({
      status: "replied",
      queued: 1,
    });
    await until(() => llm.calls.length === 3);
    await t.ctx.getRouteById("chat")!.drain();
    const parts = lastUserOf(llm.calls[2]!).map((p) => p.text);
    expect(parts.some((p) => p.includes(`Handle: ${receipt.handle}`))).toBe(
      true,
    );
  });
});

describe("the tool's shape follows the route's shape", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
    token = "";
    actionRuns = 0;
    release = undefined;
    store = new MemoryDeferralStore();
  });

  afterEach(async () => {
    release?.("released at teardown");
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A registered directTool over a parking route is background with nothing declared
   * @preconditions functions: { ask: directTool("park") } and tools(["ask"])
   * @expectedResult The model is told the tool runs in the background and receives a running handle under the registered name
   */
  test("directTool(routeId) over a parking route is background", async () => {
    t = await contextWith({
      store: store!,
      functions: { ask: directTool("park") },
      tools: ["ask"],
    }).build();
    await t.startAndWaitReady();
    const receipt = await parkFromTurn(t, "ask");
    expect(receipt.status).toBe("running");
    const advertised = (
      llm.calls[0]!.tools as Record<string, { description: string }>
    )["ask"]!;
    expect(advertised.description).toContain("runs in the background");
  });

  /**
   * @case background: false on a parking route fails context.start() naming the route
   * @preconditions functions: { ask: directTool("park", { background: false }) }
   * @expectedResult Startup rejects with RC5003 naming "park", and no model call is made
   */
  test("background: false on a parking route is refused at start", async () => {
    t = await contextWith({
      store: store!,
      functions: { ask: directTool("park", { background: false }) },
      tools: ["ask"],
    }).build();
    const outcome = await t.startAndWaitReady().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rcCodeOf(outcome)).toBe("RC5003");
    expect(String((outcome as Error).message)).toMatch(/route "park" can park/);
    expect(llm.calls).toHaveLength(0);
    // The failed start is what stop() re-awaits; it is the outcome above.
    await t.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case tools([...]) carries background, and a background direct tool keeps its direct__ name
   * @preconditions tools([{ name: "Direct(sandbox)", background: true }]) over a route that does not park
   * @expectedResult The model sees direct__sandbox as a background tool, receives a running handle, and the completion is delivered exactly as a declared background tool's
   */
  test("{ name, background } in tools([...]) makes a direct tool background", async () => {
    t = await contextWith({
      store: store!,
      tools: [{ name: "Direct(sandbox)", background: true }],
    }).build();
    await t.startAndWaitReady();
    llm.script.push(
      { toolCalls: [{ toolName: "direct__sandbox", input: { cmd: "make" } }] },
      { text: "building" },
    );
    const reply = await send(t, { session: "s", message: "build" });
    const receipt = reply.toolCalls?.[0]?.output as BackgroundToolHandle;
    expect(reply.toolCalls?.[0]?.toolName).toBe("direct__sandbox");
    expect(receipt).toMatchObject({ status: "running" });
    expect(receipt.handle).toMatch(/^sandbox:/);
    expect(Object.keys(llm.calls[0]!.tools ?? {})).toEqual(["direct__sandbox"]);
    llm.script.push({ text: "green" });
    release!("all passed");
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    expect(lastUserOf(llm.calls[1]!)[0]!.text).toContain("all passed");
  });

  /**
   * @case background in tools([...]) applies to Direct(...) references only
   * @preconditions tools([{ name: "ask", background: true }]) where ask is a registered fn
   * @expectedResult The dispatch is refused with RC5003 naming the fn, before any model call
   */
  test("background on a registered fn binding is refused", async () => {
    t = await contextWith({
      store: store!,
      functions: { ask: directTool("park") },
      tools: [{ name: "ask", background: true }],
    }).build();
    await t.startAndWaitReady();
    const outcome = await send(t, { session: "s", message: "go" }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rcCodeOf(outcome)).toBe("RC5003");
    expect(String((outcome as Error).message)).toMatch(/Direct\(<routeId>\)/);
    expect(llm.calls).toHaveLength(0);
  });

  /**
   * @case A route that does not park is synchronous unless declared background, as before
   * @preconditions tools(["Direct(sandbox)"]) with nothing declared; the model calls it
   * @expectedResult The call holds the turn until the route returns and the model sees the route's result, not a handle
   */
  test("a route that does not park stays synchronous by default", async () => {
    t = await contextWith({
      store: store!,
      tools: ["Direct(sandbox)"],
    }).build();
    await t.startAndWaitReady();
    llm.script.push(
      { toolCalls: [{ toolName: "direct__sandbox", input: { cmd: "ls" } }] },
      { text: "done" },
    );
    const pending = send(t, { session: "s", message: "run" });
    await until(() => release !== undefined);
    release!("files");
    const reply = await pending;
    expect(reply.toolCalls?.[0]?.output).toEqual({
      stdout: "files",
      cmd: "ls",
    });
    expect(await summaryOf(t, "s")).toMatchObject({ background: 0 });
  });
});

describe("whose principal runs a revived continuation", () => {
  let t: TestContext | undefined;
  const alice: Principal = {
    kind: "custom",
    scheme: "test",
    subject: "alice",
    roles: ["ops"],
    scopes: ["sessions:manage"],
  };

  beforeEach(() => {
    llm.reset();
    token = "";
    actionRuns = 0;
    release = undefined;
    store = new MemoryDeferralStore();
  });

  afterEach(async () => {
    release?.("released at teardown");
    if (t) await t.stop();
    t = undefined;
  });

  /** Park under alice and answer; the settlement is what triggers the revival. */
  async function settleUnderAlice(
    context: TestContext,
  ): Promise<{ receipt: BackgroundToolHandle; refused: unknown[] }> {
    const refused: unknown[] = [];
    context.ctx.on("route:agent:session:revival:refused", ({ details }) => {
      refused.push(details);
    });
    const receipt = await parkFromTurn(context, "direct__park", alice);
    llm.script.push({ text: "the decision came" });
    await answer(context, { verdict: "approve" });
    await until(
      async () => (await recordOf(store!, "s")).background.length === 0,
    );
    return { receipt, refused };
  }

  /**
   * @case With no reidentify hook, a principal-bearing continuation is not revived on a settlement, and does not run restored
   * @preconditions The session's turn ran under alice; no agentPlugin({ reidentify }); the park is answered
   * @expectedResult The settlement is in the inbox and the continuation stays stored; no model call is made; route:agent:session:revival:refused names the reason; a later message from alice wakes the session and that turn reads the settlement beside the message
   */
  test("no hook refuses the revival and records the settlement", async () => {
    t = await contextWith({ store: store! }).build();
    await t.startAndWaitReady();
    const { receipt, refused } = await settleUnderAlice(t);
    await sleep(100);
    expect(llm.calls).toHaveLength(1);
    expect(await summaryOf(t, "s")).toMatchObject({
      inbox: 1,
      background: 0,
      deferred: true,
      turn: "idle",
    });
    expect(refused).toEqual([
      expect.objectContaining({
        routeId: "chat",
        agentName: "max",
        session: "s",
        reason: expect.stringContaining("no reidentify hook is registered"),
      }),
    ]);
    llm.script.push({ text: "the decision came" });
    llm.script.push({ text: "caught up" });
    const reply = await send(t, { session: "s", message: "any news?" }, alice);
    expect(reply.text).toBe("the decision came");
    const parts = lastUserOf(llm.calls[1]!).map((p) => p.text);
    expect(parts.some((p) => p.includes(`Handle: ${receipt.handle}`))).toBe(
      true,
    );
    expect(parts.some((p) => p.includes("any news?"))).toBe(true);
  });

  /**
   * @case The hook re-mints the same identity live, and the revived turn runs under it
   * @preconditions agentPlugin({ reidentify }) brands a fresh principal with alice's exact fields; the park is answered
   * @expectedResult The continuation revives on the settlement, the model's next turn carries the decision, and the exchange that turn ran on carries an authentic principal for alice rather than the restored record
   */
  test("the same identity re-verified live revives the continuation", async () => {
    const chatSink = spy();
    let seen: Principal | undefined;
    t = await contextWith({
      store: store!,
      chatSink,
      reidentify: (parked) => {
        seen = parked;
        return authorityOf(t!.ctx).brand({ ...alice });
      },
    }).build();
    await t.startAndWaitReady();
    const { receipt, refused } = await settleUnderAlice(t);
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    expect(refused).toHaveLength(0);
    expect(seen?.subject).toBe("alice");
    expect(authorityOf(t.ctx).isRestored(seen)).toBe(true);
    expect(lastUserOf(llm.calls[1]!)[0]!.text).toContain(
      `Handle: ${receipt.handle}`,
    );
    expect(chatSink.received).toHaveLength(2);
    const revived = principalOf(chatSink.received[1]!);
    expect(revived?.subject).toBe("alice");
    expect(authorityOf(t.ctx).isAuthentic(revived)).toBe(true);
    expect(await summaryOf(t, "s")).toMatchObject({ inbox: 0, turns: 2 });
  });

  /**
   * @case Any difference from the parked identity, in either direction, refuses the revival
   * @preconditions The hook answers with a principal that is restored, carries another role, drops a scope, or adds a scope; or declines; or throws
   * @expectedResult The revival is refused with a reason naming the deviation, the settlement is in the inbox, the continuation stays stored, and no turn runs
   */
  test.each([
    ["restored", (parked: Principal) => parked, "not verified live"],
    [
      "a different role",
      (_p: Principal, brand: (p: Principal) => Principal) =>
        brand({ ...alice, roles: ["ops", "admin"] }),
      "differing from the parked one",
    ],
    [
      "a dropped scope",
      (_p: Principal, brand: (p: Principal) => Principal) =>
        brand({ ...alice, scopes: [] }),
      "differing from the parked one",
    ],
    [
      "an added scope",
      (_p: Principal, brand: (p: Principal) => Principal) =>
        brand({ ...alice, scopes: ["sessions:manage", "mail:send"] }),
      "differing from the parked one",
    ],
    ["a decline", () => undefined, "declined"],
    [
      "a throw",
      () => {
        throw new Error("roster unavailable");
      },
      "threw",
    ],
  ] as const)(
    "the hook answering with %s refuses the revival",
    async (_name, answerWith, reason) => {
      t = await contextWith({
        store: store!,
        reidentify: (parked) =>
          (
            answerWith as (
              p: Principal,
              b: (p: Principal) => Principal,
            ) => Principal | undefined
          )(parked, (p) => authorityOf(t!.ctx).brand(p)),
      }).build();
      await t.startAndWaitReady();
      const { refused } = await settleUnderAlice(t);
      await until(() => refused.length === 1);
      await sleep(50);
      expect(llm.calls).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        session: "s",
        reason: expect.stringContaining(reason),
      });
      expect(await summaryOf(t, "s")).toMatchObject({
        inbox: 1,
        background: 0,
        deferred: true,
      });
    },
  );

  /**
   * @case An anonymously dispatched agent revives exactly as before
   * @preconditions No principal on the chat dispatch and no reidentify hook; the park is answered
   * @expectedResult The continuation revives on the settlement and no refusal is recorded
   */
  test("an anonymous continuation revives without a hook", async () => {
    t = await contextWith({ store: store! }).build();
    await t.startAndWaitReady();
    const refused: unknown[] = [];
    t.ctx.on("route:agent:session:revival:refused", ({ details }) => {
      refused.push(details);
    });
    await parkFromTurn(t, "direct__park");
    llm.script.push({ text: "revived" });
    await answer(t, { verdict: "approve" });
    await until(() => llm.calls.length === 2);
    await t.ctx.getRouteById("chat")!.drain();
    expect(refused).toHaveLength(0);
  });

  /**
   * @case Two installs cannot both set the hook
   * @preconditions Two agentPlugin installs each pass reidentify
   * @expectedResult The build is refused with RC5003 naming "reidentify"
   */
  test("a second reidentify hook is refused at init", async () => {
    const outcome = await testContext()
      .with({
        deferral: { store: store! },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ reidentify: (p) => p }),
          agentPlugin({ reidentify: (p) => p }),
        ],
      })
      .routes(routes(spy(), spy()))
      .build()
      .then(
        async (built) => {
          t = built;
          return built.startAndWaitReady().then(
            () => undefined,
            (err: unknown) => err,
          );
        },
        (err: unknown) => err,
      );
    expect(rcCodeOf(outcome)).toBe("RC5003");
    expect(String((outcome as Error).message)).toContain("reidentify");
  });
});
