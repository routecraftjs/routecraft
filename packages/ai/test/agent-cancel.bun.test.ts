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
  AgentCancellationCause,
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

/** Incremented when `hangFn` is entered, so a test can wait for real in-flight work. */
let hangEntries = 0;

/**
 * Wait until the hang tool is actually running. Sleeping a fixed interval
 * instead would leave the test asserting on a shutdown that had nothing to
 * drain whenever the runner was slow.
 *
 * Bounded, so a routing or startup regression that stops the tool being
 * reached fails this test with a diagnostic rather than hanging the suite.
 */
const waitForHang = async (): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (hangEntries === 0 && Date.now() < deadline) await sleep(5);
  if (hangEntries === 0) {
    throw new Error("The hang tool was never entered within 5s");
  }
};

/** A tool that holds until the run's abort signal fires, then rejects. */
const hangFn = {
  description: "Waits for cancellation",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) =>
    new Promise((_resolve, reject) => {
      hangEntries += 1;
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
    hangEntries = 0;
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A forced shutdown cancels an in-flight run with AI1005; graceful stage one does not
   * @preconditions A tool that hangs until aborted, waited on rather than slept past, with shutdown.timeoutMs wide enough that the mid-drain assertion cannot race the forced stage
   * @expectedResult The run is still alive while stage one drains, and is cancelled with AI1005 only once the forced stage fires. Before #610 the first signal cancelled it immediately, which is the contract violation this pins
   */
  test("a forced shutdown cancels the run with AI1005", async () => {
    const sink = spy();
    llm.script.push({ toolCalls: [{ toolName: "hang", input: {} }] });

    t = await testContext()
      .with({
        // Generous relative to the mid-drain assertion below: a tight
        // deadline would let the forced stage fire first on a loaded runner
        // and the test would report a cancellation that stage one did not do.
        shutdown: { timeoutMs: 2_000 },
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
    await waitForHang();

    const stopping = t.ctx.stop();
    // Stage one closed intake but must NOT have touched the running agent:
    // the whole point of the split is that a drain is not a cancellation.
    await sleep(50);
    expect(llm.sawAbort()).toBe(false);

    const outcome = await stopping;
    expect(outcome.forced).toBe(true);
    expect(outcome.pending).toContain("assistant");

    const err = (await dispatch) as { rc?: string; message?: string };
    expect(err).toBeDefined();
    expect(err.rc).toBe("AI1005");
    expect(err.message).toMatch(/cancelled after 0 turn/);
    expect(llm.sawAbort()).toBe(true);
    expect(sink.received).toHaveLength(0);
    t = undefined;
  });

  /**
   * @case Graceful shutdown lets an in-flight agent run finish, and exits clean
   * @preconditions A tool that completes on its own shortly after shutdown begins, well inside the deadline
   * @expectedResult The run completes, its result reaches the destination, and the outcome is not forced. This is the report that opened #610: a cron-woken agent mid-tool-call killed by one Ctrl-C
   */
  test("graceful shutdown drains an in-flight agent run", async () => {
    const sink = spy();
    const slowFn = {
      description: "Finishes shortly, on its own",
      input: z.object({}),
      handler: async () => {
        await sleep(120);
        return { done: true };
      },
    };
    llm.script.push({ toolCalls: [{ toolName: "slow", input: {} }] });
    llm.script.push({ text: "finished" });

    t = await testContext()
      .with({
        shutdown: { timeoutMs: 5_000 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { slow: slowFn } }),
        ],
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["slow"]) }))
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const dispatch = t.client.sendDirect("assistant", "go");
    await sleep(30);

    const outcome = await t.ctx.stop();

    await dispatch;
    expect(outcome).toEqual({ forced: false, pending: [] });
    expect(llm.sawAbort()).toBe(false);
    expect(sink.received).toHaveLength(1);
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
   * @expectedResult AI1005 reports 1 turn and the accumulated token count in its message, and its cause is the typed AgentCancellationCause carrying the same spend structurally
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
        // The run is cancelled by the FORCED stage now: graceful stage one
        // drains rather than cancels, and this tool never finishes on its own.
        shutdown: { timeoutMs: 300 },
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
    await waitForHang();
    await t.stop();
    const err = (await dispatch) as {
      rc?: string;
      message?: string;
      cause?: unknown;
    };

    expect(err.rc).toBe("AI1005");
    expect(err.message).toMatch(/cancelled after 1 turn/);
    expect(err.message).toMatch(/10 tokens/);
    expect(err.cause).toBeInstanceOf(AgentCancellationCause);
    const cause = err.cause as AgentCancellationCause;
    expect(cause.turnsUsed).toBe(1);
    expect(cause.usage?.totalTokens).toBe(10);
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
        ctx.suspend({ schema: Approval }),
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
   * @case Parked work survives a FORCED shutdown too, not only a graceful one
   * @preconditions One agent run parks, a second run hangs so the deadline is reached, and shutdown.timeoutMs is short
   * @expectedResult The forced stage abandons the hung run but leaves the parked record suspended: a forced stage two may abandon execution, and must still never settle or deny a park
   */
  test("a forced shutdown never denies parked work", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    const ask = {
      description: "Ask",
      input: z.object({}),
      handler: (_i: unknown, ctx: FnHandlerContext) =>
        ctx.suspend({ schema: Approval }),
    };
    llm.script.push({ toolCalls: [{ toolName: "ask", input: {} }] });
    llm.script.push({ toolCalls: [{ toolName: "hang", input: {} }] });

    t = await testContext()
      .with({
        suspension: {
          store,
          secret: "cancel-test-secret-key-0123456789-abcdef",
        },
        shutdown: { timeoutMs: 300 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ask, hang: hangFn } }),
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
              tools: tools(["ask", "hang"]),
            }),
          )
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = await t.client.sendDirect("assistant", "go");
    expect(isSuspended(parked)).toBe(true);
    const id = (parked as { suspensionId: string }).suspensionId;

    // A second run that never finishes, so the deadline is what ends the stop.
    void t.client.sendDirect("assistant", "again").catch(() => undefined);
    await waitForHang();

    const outcome = await t.ctx.stop();
    expect(outcome.forced).toBe(true);

    const record = await store.get(id);
    expect(record?.status).toBe("suspended");
    t = undefined;
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
