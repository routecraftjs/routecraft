import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  DefaultExchange,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  isSuspended,
  noop,
  type Suspended,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import type { CraftPlugin } from "@routecraft/routecraft";
import {
  SuspendError,
  agent,
  agentPlugin,
  llmPlugin,
  tools,
  AgentEnricherAdapter,
  type AgentResult,
  type FnHandlerContext,
} from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

// One process-global scripted dispatcher; each test refills its script.
// Registered at module load like every other file that mocks this barrel.
const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const Approval = z.object({ approved: z.boolean() });

const MODEL = "anthropic:claude-opus-4-7";

/** Plugins every suspending agent context needs: a provider and the fns. */
type PluginFns = NonNullable<
  NonNullable<Parameters<typeof agentPlugin>[0]>["functions"]
>;
function plugins(functions: PluginFns): CraftPlugin[] {
  return [
    llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
    agentPlugin({ functions }),
  ];
}

function asSuspended(value: unknown): Suspended {
  if (!isSuspended(value)) {
    throw new Error(
      `expected a Suspended acknowledgment, got ${String(value)}`,
    );
  }
  return value;
}

describe("agent durable suspension (ctx.suspend)", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const askFn = {
    description: "Ask a human for approval",
    input: z.object({ question: z.string() }),
    handler: (input: unknown, ctx: FnHandlerContext) =>
      ctx.suspend({
        expect: Approval,
        ttl: "72h",
        question: (input as { question: string }).question,
      }),
  };

  const assistantRoutes = (sink: ReturnType<typeof spy>) => [
    craft()
      .id("assistant")
      .from(direct())
      .to(agent({ model: MODEL, system: "be useful", tools: tools(["ask"]) }))
      .to(sink),
    craft().id("answers").from(direct()).resume(),
  ];

  /**
   * @case A fn handler's ctx.suspend parks the run and execution one answers with the core Suspended value
   * @preconditions direct-fronted agent route; scripted model calls the "ask" tool, whose handler returns ctx.suspend({ expect, ttl, question })
   * @expectedResult The caller receives the branded Suspended acknowledgment carrying id, token, the Approval JSON Schema and the question; the sink after the agent has not run; ctx.suspensionId matched the acknowledgment's id
   */
  test("ctx.suspend parks the run and answers with the Suspended acknowledgment", async () => {
    const sink = spy();
    const seenIds: Array<string | undefined> = [];
    const askWithCapture = {
      ...askFn,
      handler: (input: unknown, ctx: FnHandlerContext) => {
        seenIds.push(ctx.suspensionId);
        expect(ctx.suspension?.id).toBe(ctx.suspensionId!);
        expect(ctx.suspension?.token).toBeString();
        return ctx.suspend({
          expect: Approval,
          ttl: "72h",
          question: (input as { question: string }).question,
        });
      },
    };
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askWithCapture }) })
      .routes(assistantRoutes(sink))
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    expect(parked.status).toBe("suspended");
    expect(parked.suspensionId).toBeString();
    expect(parked.token).toBeString();
    expect(parked.question).toBe("pay acme?");
    expect(parked.expect).toBeDefined();
    expect(parked.expiresAt).toBeString();
    expect(seenIds[0]).toBe(parked.suspensionId);
    expect(sink.received).toHaveLength(0);
    // The loop stopped at the park: no further scripted turns were consumed.
    expect(llm.script).toHaveLength(0);
  });

  /**
   * @case A resumed answer re-enters the agent step, lands as the suspended call's tool result, and the loop finishes
   * @preconditions A parked run; the resume ingress receives the token plus an answer; one more scripted text turn
   * @expectedResult The acknowledgment reports a completed execution two, the sink receives the final AgentResult, the second model call's thread contains the answer as the suspended call's tool result, and a duplicate resume returns the cached outcome without another model call
   */
  test("resume re-enters the loop with the answer and a duplicate is idempotent", async () => {
    const sink = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn }) })
      .routes(assistantRoutes(sink))
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    llm.script.push({ text: "done: approved" });

    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(ack.status).toBe("resumed");
    expect(ack.outcome.status).toBe("completed");

    expect(sink.received).toHaveLength(1);
    const result = sink.received[0]!.body as AgentResult;
    expect(result.text).toBe("done: approved");

    // The second model call received the persisted thread with the answer
    // swapped into the suspended call's tool result.
    expect(llm.calls).toHaveLength(2);
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain('"approved":true');
    expect(resumedPrompt).toContain('"tool-result"');

    const duplicate = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Suspension during a parallel batch flushes in-flight siblings and persists their real results
   * @preconditions One batch calling "ask" (suspends) and "lookup" (answers slowly); resume afterwards
   * @expectedResult The park waits for the sibling, whose real output is in the persisted thread the resumed model call receives alongside the swapped answer
   */
  test("a suspending call flushes in-flight siblings and keeps their results", async () => {
    const sink = spy();
    const lookup = {
      description: "Look up a record",
      input: z.object({}),
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { sku: 42 };
      },
    };
    llm.script.push({
      toolCalls: [
        { toolName: "ask", input: { question: "ok?" } },
        { toolName: "lookup", input: {} },
      ],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn, lookup }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({
              model: MODEL,
              system: "x",
              tools: tools(["ask", "lookup"]),
            }),
          )
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    llm.script.push({ text: "done" });
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });

    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain('"sku":42');
    expect(resumedPrompt).toContain('"approved":true');
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Two suspend signals in one batch produce exactly one park (one record per sequence number)
   * @preconditions One batch calling "ask" then "ask2", both of whose handlers suspend
   * @expectedResult One suspension record exists; the acknowledgment carries the FIRST call's question; after resume, the loser's tool result reads as a retryable sibling-suspended error in the thread
   */
  test("a second suspend in one batch converts to a retryable tool error", async () => {
    const sink = spy();
    const ask2 = {
      description: "Ask something else",
      input: z.object({ question: z.string() }),
      handler: (input: unknown, ctx: FnHandlerContext) =>
        ctx.suspend({
          expect: Approval,
          question: (input as { question: string }).question,
        }),
    };
    llm.script.push({
      toolCalls: [
        { toolName: "ask", input: { question: "first?" } },
        { toolName: "ask2", input: { question: "second?" } },
      ],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn, ask2 }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({ model: MODEL, system: "x", tools: tools(["ask", "ask2"]) }),
          )
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    expect(parked.question).toBe("first?");

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const pending = await runtime.store.pending();
    expect(pending.count).toBe(1);

    llm.script.push({ text: "done" });
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain("already suspended the run");
    expect(resumedPrompt).toContain('"approved":true');
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case The SuspendError throw is honoured as an escape hatch, with an open expect
   * @preconditions Handler throws SuspendError({ question }) without an expect schema
   * @expectedResult The run parks with the question on the acknowledgment; a later answer of any JSON shape resumes the loop (the model validates, not the framework)
   */
  test("SuspendError parks the run and any JSON answer resumes it", async () => {
    const sink = spy();
    const legacy = {
      description: "Legacy suspending tool",
      input: z.object({}),
      handler: (): never => {
        throw new SuspendError({ question: "legacy?" });
      },
    };
    llm.script.push({ toolCalls: [{ toolName: "legacy", input: {} }] });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ legacy }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["legacy"]) }))
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    expect(parked.question).toBe("legacy?");

    llm.script.push({ text: "carried on" });
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: "free-form text, no schema anywhere",
    })) as { status: string };
    expect(ack.status).toBe("resumed");
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain("free-form text, no schema anywhere");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A re-entrant resume skips expect validation: a token holder can send any JSON
   * @preconditions ctx.suspend declared expect: Approval; the answer is a string that does not satisfy it
   * @expectedResult The resume is accepted (no RC5049) and the raw answer reaches the model as the tool result, which is the documented model-validates property
   */
  test("an agent resume accepts an answer the expect schema would reject", async () => {
    const sink = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "ok?" } }],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn }) })
      .routes(assistantRoutes(sink))
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    llm.script.push({ text: "handled junk" });
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: "not an approval object",
    })) as { status: string; outcome: { status: string } };
    expect(ack.status).toBe("resumed");
    expect(ack.outcome.status).toBe("completed");
    expect(JSON.stringify(llm.calls[1]!.user)).toContain(
      "not an approval object",
    );
  });

  /**
   * @case The maxTurns budget survives the park: a resume with the budget exhausted takes the ordinary max-turns path
   * @preconditions agent maxTurns: 1; the park consumed the single turn; then a resume arrives
   * @expectedResult Execution two fails immediately with the max-turns RC5003 as the suspension's terminal outcome, without another model call
   */
  test("a resumed run inherits turnsUsed and an exhausted budget fails as max-turns", async () => {
    const sink = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "ok?" } }],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({
              model: MODEL,
              system: "x",
              tools: tools(["ask"]),
              maxTurns: 1,
            }),
          )
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as {
      status: string;
      outcome: { status: string; error?: { message: string } };
    };
    expect(ack.outcome.status).toBe("failed");
    expect(ack.outcome.error?.message).toMatch(/maxTurns \(1\) reached/);
    // No second model call was spent on a budget that was already gone.
    expect(llm.calls).toHaveLength(1);
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case ctx.suspend in a context without a suspension runtime fails as a typed step error naming the config line
   * @preconditions No `suspension` block on the config (legal: the route has no static .suspend()); the tool suspends at runtime
   * @expectedResult The dispatch fails with RC5052 telling the user to add suspension: {} to defineConfig; nothing is parked
   */
  test("ctx.suspend without a suspension runtime fails with RC5052", async () => {
    const sink = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "ok?" } }],
    });

    t = await testContext()
      .with({ plugins: plugins({ ask: askFn }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["ask"]) }))
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("assistant", "go")).rejects.toMatchObject({
      rc: "RC5052",
    });
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case A suspension signal in an identity-less (synthetic) dispatch is refused with AI1006 and writes nothing
   * @preconditions The agent adapter is invoked directly on an exchange with no route binding; the tool calls ctx.suspend
   * @expectedResult ctx.suspend throws AI1006 at the call (surfaced as that tool call's error), the dispatch itself completes, and the suspension store holds no record
   */
  test("an identity-less dispatch refuses ctx.suspend with AI1006 and writes no record", async () => {
    llm.script.push(
      { toolCalls: [{ toolName: "ask", input: { question: "ok?" } }] },
      { text: "recovered without suspending" },
    );

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askFn }) })
      .routes([craft().id("unrelated").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    const adapter = new AgentEnricherAdapter({
      kind: "inline",
      options: { model: MODEL, system: "x", tools: tools(["ask"]) },
    });
    const exchange = new DefaultExchange(t.ctx, { body: "go", headers: {} });
    const result = await adapter.fetch(exchange);

    expect(result.text).toBe("recovered without suspending");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.error).toMatchObject({ rc: "AI1006" });

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const pending = await runtime.store.pending();
    expect(pending.count).toBe(0);
  });
});
