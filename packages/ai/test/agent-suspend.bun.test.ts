import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  DefaultExchange,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  noop,
} from "@routecraft/routecraft";
import {
  asSuspended,
  spy,
  testContext,
  type TestContext,
} from "@routecraft/testing";
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
import { makeFnHandlerContext } from "../src/fn/handler-context.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { Approval, MODEL, askFn } from "./helpers/suspend-fixtures.ts";

// One process-global scripted dispatcher; each test refills its script.
// Registered at module load like every other file that mocks this barrel.
const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

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

describe("agent durable suspension (ctx.suspend)", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const assistantRoutes = (sink: ReturnType<typeof spy>) => [
    craft()
      .id("assistant")
      .from(direct())
      .to(agent({ model: MODEL, system: "be useful", tools: tools(["ask"]) }))
      .to(sink),
    craft().id("answers").from(direct()).resume(),
  ];

  /**
   * @case A fn handler's ctx.suspend parks the run, and execution one answers with the core Suspended value
   * @preconditions direct-fronted agent route; scripted model calls the "ask" tool, whose handler returns ctx.suspend({ schema, ttl, meta })
   * @expectedResult The caller receives the branded Suspended acknowledgment carrying id, token and the Approval JSON Schema, with no trace of `meta` on it; the record persists `meta` verbatim; the sink after the agent has not run; ctx.suspensionId matched the acknowledgment's id
   */
  test("ctx.suspend parks the run and answers with the Suspended acknowledgment", async () => {
    const sink = spy();
    const seenIds: Array<string | undefined> = [];
    // Recorded, not asserted, inside the handler: the tool bridge converts
    // a handler throw (a failed expect() included) into an error-text tool
    // result, so an in-handler assertion would surface as an unrelated
    // failure at the acknowledgment instead of reporting itself.
    const seenSuspensions: Array<{
      id: string | undefined;
      token: string | undefined;
    }> = [];
    const askWithCapture = {
      ...askFn,
      handler: (input: unknown, ctx: FnHandlerContext) => {
        seenIds.push(ctx.suspensionId);
        seenSuspensions.push({
          id: ctx.suspension?.id,
          token: ctx.suspension?.token,
        });
        return ctx.suspend({
          schema: Approval,
          ttl: "72h",
          meta: { question: (input as { question: string }).question },
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
    expect(parked.schema).toBeDefined();
    expect(parked.expiresAt).toBeString();
    // `meta` is hook input, not wire data. It rides the record and is handed
    // to `.resume({ authorize })`; the acknowledgment crosses to the caller,
    // so anything policy-shaped on it would be readable by the party the
    // hook exists to judge.
    expect(Object.keys(parked)).not.toContain("meta");
    expect(JSON.stringify(parked)).not.toContain("pay acme?");

    const store = t.ctx.getStore(SUSPENSION_RUNTIME)!.store;
    const record = await store.get(parked.suspensionId);
    expect(record!.meta).toEqual({ question: "pay acme?" });
    expect(seenIds[0]).toBe(parked.suspensionId);
    expect(seenSuspensions[0]!.id).toBe(seenIds[0]!);
    expect(seenSuspensions[0]!.token).toBeString();
    expect(sink.received).toHaveLength(0);
    // The loop stopped at the park: no further scripted turns were consumed.
    expect(llm.script).toHaveLength(0);
  });

  /**
   * @case A resumed answer re-enters the agent step, lands as the suspended call's tool result, and the loop finishes
   * @preconditions A parked run; the resume ingress receives the token plus an answer; one more scripted text turn
   * @expectedResult The acknowledgment reports that execution two completed, the sink receives the final AgentResult, the second model call's thread contains the answer as the suspended call's tool result, and a duplicate resume returns the cached outcome without another model call
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
   * @case A revived agent run parks AGAIN later in the same continuation, minting a fresh suspension
   * @preconditions Park one is resumed; the resumed model asks the "ask" tool a second question; a second resume answers it
   * @expectedResult The second park is a new record under a new id and token (never a re-serialization of the first stepState), the first resume's outcome reports "suspended" with no body, and the second resume completes the run with both answers in the final model call's thread
   */
  test("a resumed run can park again: two suspensions, two resumes, one completion", async () => {
    const sink = spy();
    const tokens: string[] = [];
    const ids: string[] = [];
    const askWithCapture = {
      ...askFn,
      handler: (input: unknown, ctx: FnHandlerContext) => {
        ids.push(ctx.suspensionId!);
        tokens.push(ctx.suspension!.token);
        return ctx.suspend({
          schema: Approval,
          meta: { question: (input as { question: string }).question },
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
    // The resumed model immediately asks a second question, parking again.
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "ship it too?" } }],
    });
    const first = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body?: unknown } };
    expect(first.status).toBe("resumed");
    expect(first.outcome.status).toBe("suspended");
    // No body: handing the second acknowledgment (token included) to the
    // first answerer would give approver A approver B's capability.
    expect(first.outcome.body).toBeUndefined();

    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(sink.received).toHaveLength(0);

    llm.script.push({ text: "both approved" });
    const second = (await t.client.sendDirect("answers", {
      token: tokens[1]!,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(second.status).toBe("resumed");
    expect(second.outcome.status).toBe("completed");

    expect(sink.received).toHaveLength(1);
    expect((sink.received[0]!.body as AgentResult).text).toBe("both approved");
    // The final call's thread carries both suspended calls' answers.
    expect(llm.calls).toHaveLength(3);
    const finalPrompt = JSON.stringify(llm.calls[2]!.user);
    expect(finalPrompt).toContain("pay acme?");
    expect(finalPrompt).toContain("ship it too?");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Token spend survives the park: a cancelled resumed run reports the whole run's usage
   * @preconditions Turn one reports 10 tokens and parks; the record persists stepState.usage; the resumed turn hangs in a tool until the context stops
   * @expectedResult The parked record carries usage.totalTokens 10, and the cancellation of the resumed run fails with AI1005 reporting 1 turn and the 10 pre-park tokens rather than a spend of nothing
   */
  test("a cancelled resumed run reports the pre-park token spend", async () => {
    const sink = spy();
    const hang = {
      description: "Hang until the run is cancelled",
      input: z.object({}),
      handler: (_input: unknown, ctx: FnHandlerContext) =>
        new Promise((_resolve, reject) => {
          ctx.abortSignal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    };
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    });

    t = await testContext()
      .with({
        suspension: {},
        // The hang tool never finishes, so it is the FORCED stage that
        // cancels the resumed run: graceful stage one drains rather than
        // cancels. A short deadline keeps the test honest about which stage
        // does the cancelling.
        shutdown: { timeoutMs: 300 },
        plugins: plugins({ ask: askFn, hang }),
      })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(
            agent({ model: MODEL, system: "x", tools: tools(["ask", "hang"]) }),
          )
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const record = await runtime.store.get(parked.suspensionId);
    expect(
      (record?.stepState as { usage?: { totalTokens?: number } })?.usage
        ?.totalTokens,
    ).toBe(10);

    // The resumed turn hangs in a tool; the forced stage of shutdown cancels it.
    llm.script.push({ toolCalls: [{ toolName: "hang", input: {} }] });
    const ack = t.client
      .sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      })
      .then(
        (value) =>
          value as {
            outcome: {
              status: string;
              error?: { rc?: string; message?: string };
            };
          },
      )
      .catch((err: unknown) => err as { rc?: string; message?: string });
    const deadline = Date.now() + 2_000;
    while (llm.calls.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(llm.calls.length).toBe(2);
    await t.stop();

    const settled = await ack;
    const text = JSON.stringify(settled);
    expect(text).toContain("AI1005");
    expect(text).toMatch(
      /cancelled after 1 turn\(s\)? and 10 tokens|1 turn\(s\) and 10 tokens/,
    );
    t = undefined;
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

    expect(llm.calls.length).toBeGreaterThanOrEqual(2);
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain('"sku":42');
    expect(resumedPrompt).toContain('"approved":true');
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Two suspend signals in one batch produce exactly one park (one record per sequence number)
   * @preconditions One batch calling "ask" then "ask2", both of whose handlers suspend
   * @expectedResult One suspension record exists and carries the FIRST call's meta; after resume, the loser's tool result reads as a retryable sibling-suspended error in the thread
   */
  test("a second suspend in one batch converts to a retryable tool error", async () => {
    const sink = spy();
    const ask2 = {
      description: "Ask something else",
      input: z.object({ question: z.string() }),
      handler: (input: unknown, ctx: FnHandlerContext) =>
        ctx.suspend({
          schema: Approval,
          meta: { question: (input as { question: string }).question },
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

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const pending = await runtime.store.pending();
    expect(pending.count).toBe(1);
    const record = await runtime.store.get(parked.suspensionId);
    expect(record!.meta).toEqual({ question: "first?" });

    llm.script.push({ text: "done" });
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    expect(llm.calls.length).toBeGreaterThanOrEqual(2);
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain("already suspended the run");
    expect(resumedPrompt).toContain('"approved":true');
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case meta attached by a tool handler reaches the resume route's hook
   * @preconditions ctx.suspend({ meta }) on the agent surface, resumed through a door whose authorize reads it
   * @expectedResult The hook receives the same value the handler attached, so agent parks and route parks are one mechanism
   */
  test("ctx.suspend meta round-trips to the resume hook", async () => {
    const sink = spy();
    const seen: unknown[] = [];
    const askWithMeta = {
      ...askFn,
      handler: (_input: unknown, ctx: FnHandlerContext) =>
        ctx.suspend({
          schema: Approval,
          meta: { channel: "finance", requires: ["payouts:approve"] },
        }),
    };
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
    });

    t = await testContext()
      .with({ suspension: {}, plugins: plugins({ ask: askWithMeta }) })
      .routes([
        craft()
          .id("assistant")
          .from(direct())
          .to(agent({ model: MODEL, system: "x", tools: tools(["ask"]) }))
          .to(sink),
        craft()
          .id("answers")
          .from(direct())
          .resume(
            (ex) => ({
              token: (ex.body as { token: string }).token,
              result: { approved: true },
            }),
            {
              authorize: ({ record }) => {
                seen.push(record.meta);
                return true;
              },
            },
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("assistant", "go"));
    llm.script.push({ text: "done" });
    await t.client.sendDirect("answers", { token: parked.token });

    expect(seen[0]).toEqual({
      channel: "finance",
      requires: ["payouts:approve"],
    });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A losing sibling's credential cannot resume the winner's park
   * @preconditions One batch calling two suspending tools, each capturing its own ctx.suspension.token before returning
   * @expectedResult The loser's token is refused with RC5055 without touching the record, and the winner's token still resumes the run
   */
  test("a losing sibling's credential is refused", async () => {
    const sink = spy();
    const tokens: Record<string, string> = {};
    const capture = (name: string) => ({
      description: `Ask via ${name}`,
      input: z.object({ question: z.string() }),
      handler: (input: unknown, ctx: FnHandlerContext) => {
        tokens[name] = ctx.suspension!.token;
        return ctx.suspend({
          schema: Approval,
          meta: { question: (input as { question: string }).question },
        });
      },
    });
    llm.script.push({
      toolCalls: [
        { toolName: "ask", input: { question: "first?" } },
        { toolName: "ask2", input: { question: "second?" } },
      ],
    });

    t = await testContext()
      .with({
        suspension: {},
        plugins: plugins({ ask: capture("ask"), ask2: capture("ask2") }),
      })
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
    expect(tokens["ask"]).not.toBe(tokens["ask2"]);

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    // One record, one park, two credentials: they name the calls, not the
    // park, which is exactly what makes the losing one refusable.
    const record = await runtime.store.get(parked.suspensionId);
    expect(record!.meta).toEqual({ question: "first?" });
    // The acknowledgment carries the WINNING call's binding, so the link
    // the winning handler already sent its recipient is the one that works.
    expect(runtime.signer.verify(parked.token).sub).toBe(
      runtime.signer.verify(tokens["ask"]!).sub,
    );
    expect(runtime.signer.verify(tokens["ask2"]!).sub).not.toBe(
      runtime.signer.verify(parked.token).sub,
    );
    await expect(
      t.client.sendDirect("answers", {
        token: tokens["ask2"],
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5055" });
    expect((await runtime.store.get(parked.suspensionId))?.status).toBe(
      "suspended",
    );

    llm.script.push({ text: "done" });
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string };
    expect(ack.status).toBe("resumed");
  });

  /**
   * @case The SuspendError throw is honoured as an escape hatch, with no declared schema
   * @preconditions Handler throws SuspendError({ meta }) declaring no schema
   * @expectedResult The run parks, the acknowledgment advertises no schema, and a later payload of any JSON shape resumes the loop (the model validates, not the framework)
   */
  test("SuspendError parks the run and any JSON payload resumes it", async () => {
    const sink = spy();
    const legacy = {
      description: "Legacy suspending tool",
      input: z.object({}),
      handler: (): never => {
        throw new SuspendError({ meta: { question: "legacy?" } });
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
    expect(parked.schema).toBeUndefined();

    llm.script.push({ text: "carried on" });
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: "free-form text, no schema anywhere",
    })) as { status: string };
    expect(ack.status).toBe("resumed");
    expect(llm.calls.length).toBeGreaterThanOrEqual(2);
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain("free-form text, no schema anywhere");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A re-entrant resume skips expect validation: a token holder can send any JSON
   * @preconditions ctx.suspend declared schema: Approval; the answer is a string that does not satisfy it
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
    expect(llm.calls.length).toBeGreaterThanOrEqual(2);
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

  /**
   * @case A malformed ttl is refused at the ctx.suspend call, before the
   *   handler unwinds
   * @preconditions A wired handler context (the dispatch could park); the
   *   handler passes ttl: "3 days", which the duration grammar rejects
   * @expectedResult RC5003 thrown synchronously from ctx.suspend itself,
   *   with the tool named in the message, instead of surfacing later at
   *   signal conversion with the framework's call frame
   */
  test("ctx.suspend rejects a malformed ttl with RC5003 at the call", () => {
    const ctx = makeFnHandlerContext(
      "ask",
      new AbortController().signal,
      undefined,
      { id: "sus-1", mintToken: () => "token" },
    );

    expect(() => ctx.suspend({ ttl: "3 days" as never })).toThrow();
    try {
      ctx.suspend({ ttl: "3 days" as never });
    } catch (error) {
      expect(error).toMatchObject({ rc: "RC5003" });
      expect(String((error as Error).message)).toContain('tool "ask"');
    }
    // The grammar's accepted forms still mint the sentinel.
    expect(ctx.suspend({ ttl: "72h" }).status).toBe("suspend-requested");
  });
});
