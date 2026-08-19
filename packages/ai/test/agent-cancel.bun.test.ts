import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  isSuspended,
  noop,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  type FnHandlerContext,
} from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const MODEL = "anthropic:claude-opus-4-7";
const Approval = z.object({ approved: z.boolean() });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A tool that holds until the run's abort signal fires, then rejects. */
const hangFn = {
  description: "Waits for cancellation",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) =>
    new Promise((_resolve, reject) => {
      const abort = (): void => {
        const err = new Error("hang tool aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
    }),
};

describe("cooperative cancellation of agent runs", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case context.stop() during a long agent run has defined behaviour: a typed AI1005 failure, not a hang and not a fake success
   * @preconditions The scripted model calls a tool that holds until the abort signal fires; the context is stopped mid-dispatch
   * @expectedResult The dispatch fails with the agent-run-cancelled error, the emulated model call observed the abort, and the context stops cleanly
   */
  test("context.stop() cancels the run with AI1005", async () => {
    const sink = spy();
    llm.script.push({ toolCalls: [{ toolName: "hang", input: {} }] });

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { hang: hangFn } }),
        ],
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["hang"]) }))
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const dispatch = t.client
      .sendDirect("assistant", "go")
      .then(() => undefined)
      .catch((err: unknown) => err);
    await sleep(30);
    await t.stop();
    const err = (await dispatch) as { rc?: string; message?: string };

    expect(err).toBeDefined();
    expect(err.rc).toBe("AI1005");
    expect(err.message).toMatch(/cancelled after 0 turn/);
    expect(llm.sawAbort()).toBe(true);
    expect(sink.received).toHaveLength(0);
    t = undefined;
  });

  /**
   * @case The abort reaches the model call through a step-scope .timeout(): the run does not finish the turn and discard it
   * @preconditions .timeout(30) wraps the agent step; the tool holds past the deadline
   * @expectedResult The caller receives RC5011 from the wrapper, and the emulated model call observed the abort (the step signal is merged into the dispatch signal)
   */
  test("a step-scope timeout aborts the model call underneath", async () => {
    const sink = spy();
    llm.script.push({ toolCalls: [{ toolName: "hang", input: {} }] });

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { hang: hangFn } }),
        ],
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .timeout(30)
          .to(agent({ model: MODEL, system: "x", tools: tools(["hang"]) }))
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("assistant", "go")).rejects.toMatchObject({
      rc: "RC5011",
    });
    // The abandoned dispatch settles once its abort propagates.
    await sleep(50);
    expect(llm.sawAbort()).toBe(true);
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case The cancellation error carries the spend so far: turns completed and token usage
   * @preconditions One completed model call (a validate retry sends the loop back), then a second call that hangs until the stop
   * @expectedResult AI1005 reports 1 turn and the accumulated token count in its message
   */
  test("AI1005 reports turns completed and tokens spent", async () => {
    const sink = spy();
    llm.script.push(
      {
        text: "first draft",
        usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      },
      { toolCalls: [{ toolName: "hang", input: {} }] },
    );

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { hang: hangFn } }),
        ],
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({
              model: MODEL,
              system: "x",
              tools: tools(["hang"]),
              validate: (result) =>
                result.text === "first draft" ? "not good enough" : undefined,
            }),
          )
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const dispatch = t.client
      .sendDirect("assistant", "go")
      .then(() => undefined)
      .catch((err: unknown) => err);
    await sleep(30);
    await t.stop();
    const err = (await dispatch) as { rc?: string; message?: string };

    expect(err.rc).toBe("AI1005");
    expect(err.message).toMatch(/cancelled after 1 turn/);
    expect(err.message).toMatch(/10 tokens/);
    t = undefined;
  });

  /**
   * @case A Direct(...) tool observes the abort: no new dispatch starts after cancellation, and an in-flight one unwinds the agent promptly
   * @preconditions directTool resolved against a live context; one call with a pre-aborted signal, one aborted mid-dispatch
   * @expectedResult The pre-aborted call rejects without reaching the downstream route; the mid-flight call rejects as an abort while the downstream route finishes under its own lifecycle
   */
  test("directTool dispatch observes the run's abort signal", async () => {
    const reached: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: {} }),
        ],
      })
      .routes([
        craft()
          .id("slow-route")
          .description("slow downstream")
          .input({ body: z.object({}) })
          .from(direct())
          .process(async (ex) => {
            reached.push(ex.body);
            await sleep(120);
            return ex;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = directTool("slow-route");
    const fn = deferred.resolve(t.ctx, "slowTool");
    const baseCtx = {
      logger: t.ctx.logger,
      suspend: () => {
        throw new Error("not under test");
      },
    };

    const aborted = new AbortController();
    aborted.abort("cancelled before dispatch");
    await expect(
      fn.handler({}, {
        ...baseCtx,
        abortSignal: aborted.signal,
      } as unknown as FnHandlerContext),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reached).toHaveLength(0);

    const midFlight = new AbortController();
    const call = fn.handler({}, {
      ...baseCtx,
      abortSignal: midFlight.signal,
    } as unknown as FnHandlerContext);
    await sleep(20);
    midFlight.abort("cancelled mid-flight");
    await expect(Promise.resolve(call)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(reached).toHaveLength(1);
  });

  /**
   * @case Parked work SURVIVES context.stop(): cancellation of a live run and shutdown of a process are different things
   * @preconditions An agent run parks; the context is then stopped
   * @expectedResult The suspension record is still "suspended" in the store after the stop; nothing denied it
   */
  test("context.stop() never denies parked work", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    const ask = {
      description: "Ask",
      input: z.object({}),
      handler: (_i: unknown, ctx: FnHandlerContext) =>
        ctx.suspend({ expect: Approval }),
    };
    llm.script.push({ toolCalls: [{ toolName: "ask", input: {} }] });

    t = await testContext()
      .with({
        suspension: {
          store,
          secret: "cancel-test-secret-key-0123456789-abcdef",
        },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ask } }),
        ],
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["ask"]) }))
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = await t.client.sendDirect("assistant", "go");
    expect(isSuspended(parked)).toBe(true);
    const id = (parked as { suspensionId: string }).suspensionId;

    await t.stop();
    t = undefined;

    const record = await store.get(id);
    expect(record?.status).toBe("suspended");
  });

  /**
   * @case SPEC (lands with #226): cancelling a parent agent cancels its delegated sub-agents
   * @preconditions A parent agent that delegated to a sub-agent (sub-agent delegation, #226, not yet shipped); the parent's run is aborted mid-delegation
   * @expectedResult The child's dispatch observes the same abort signal (the parent's signal is the child's), the child's model call stops paying for tokens, and the parent's AI1005 accounts for the child's partial spend. Skipped until #226 provides a delegation surface to drive; the wiring exists (one abort signal threads dispatch-wide through session, tool bridge, and directTool).
   */
  test.skip("cancelling a parent cancels its sub-agents (needs #226)", () => {
    // Specified now per #552's acceptance criteria; implemented with #226.
  });
});
