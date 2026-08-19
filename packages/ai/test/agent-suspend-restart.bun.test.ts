import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  isSuspended,
  type RouteDefinition,
  type Suspended,
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
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const Approval = z.object({ approved: z.boolean() });
const MODEL = "anthropic:claude-opus-4-7";

/**
 * Tokens must survive the simulated restart, so both contexts share one
 * signing secret (32-byte floor enforced) and one store instance: the
 * process is the restart unit, and a fresh context over a durable store is
 * the framework's own model of a restart (`close()` keeps records).
 */
const SECRET = "agent-restart-test-secret-key-0123456789";

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

function buildRoutes(
  sink: ReturnType<typeof spy>,
  system: string,
): RouteDefinition[] {
  return [
    ...craft()
      .id("assistant")
      .from(direct())
      .to(agent({ model: MODEL, system, tools: tools(["ask"]) }))
      .to(sink)
      .build(),
    ...craft().id("answers").from(direct()).resume().build(),
  ];
}

function contextWith(
  store: MemorySuspensionStore,
  sink: ReturnType<typeof spy>,
  system: string,
): ReturnType<ReturnType<typeof testContext>["routes"]> {
  return testContext()
    .with({
      suspension: { store, secret: SECRET },
      plugins: [
        llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        agentPlugin({ functions: { ask: askFn } }),
      ],
    })
    .routes(buildRoutes(sink, system));
}

function asSuspended(value: unknown): Suspended {
  if (!isSuspended(value)) {
    throw new Error(
      `expected a Suspended acknowledgment, got ${String(value)}`,
    );
  }
  return value;
}

describe("agent suspension across a restart (stepState adoption)", () => {
  let a: TestContext | undefined;
  let b: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (a) await a.stop();
    if (b) await b.stop();
    a = b = undefined;
  });

  /**
   * @case A suspended agent survives a restart: park in one process, resume in the next, loop continues to a final AgentResult
   * @preconditions Context A parks the run (stepState written through the shared store) and stops; context B is built fresh over the same store and secret
   * @expectedResult B's resume revives the loop at the suspended tool call with the answer in place, B's sink receives the final AgentResult, and a duplicate resume returns the first outcome without re-running anything
   */
  test("kill, restart, resume: the loop continues to a final AgentResult", async () => {
    const store = new MemorySuspensionStore();
    const sinkA = spy();
    const sinkB = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
    });

    a = await contextWith(store, sinkA, "be useful").build();
    await a.startAndWaitReady();
    const parked = asSuspended(await a.client.sendDirect("assistant", "go"));
    await a.stop();
    a = undefined;

    b = await contextWith(store, sinkB, "be useful").build();
    await b.startAndWaitReady();
    llm.script.push({ text: "done after restart" });

    const ack = (await b.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(ack.status).toBe("resumed");
    expect(ack.outcome.status).toBe("completed");

    expect(sinkA.received).toHaveLength(0);
    expect(sinkB.received).toHaveLength(1);
    const result = sinkB.received[0]!.body as AgentResult;
    expect(result.text).toBe("done after restart");
    // The resumed model call carried the pre-restart thread with the answer
    // swapped into the suspended call's tool result.
    const resumedPrompt = JSON.stringify(llm.calls[1]!.user);
    expect(resumedPrompt).toContain('"approved":true');

    const duplicate = (await b.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
    expect(b.errors).toHaveLength(0);
  });

  /**
   * @case Editing an inline agent's options under a parked run invalidates it through the RC5048 re-ask path
   * @preconditions Context A parks with system "v1" and stops; context B redeploys the route with system "v2" (the agent step heads the hashed continuation)
   * @expectedResult The resume is refused with RC5048 in the ingress, the record is denied, and the suspended route's error channel received the re-ask
   */
  test("an edited inline agent invalidates its parked run with RC5048", async () => {
    const store = new MemorySuspensionStore();
    const sinkA = spy();
    const sinkB = spy();
    llm.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "pay acme?" } }],
    });

    a = await contextWith(store, sinkA, "v1").build();
    await a.startAndWaitReady();
    const parked = asSuspended(await a.client.sendDirect("assistant", "go"));
    await a.stop();
    a = undefined;

    b = await contextWith(store, sinkB, "v2").build();
    await b.startAndWaitReady();

    await expect(
      b.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5048" });

    const record = await store.get(parked.suspensionId);
    expect(record?.status).toBe("denied");
    // The re-ask reached the suspended route's own error channel, which has
    // no handler here, so the failure surfaces on the context's error log.
    expect(b.errors.some((e) => (e as { rc?: string }).rc === "RC5048")).toBe(
      true,
    );
    expect(sinkB.received).toHaveLength(0);
    expect(llm.calls).toHaveLength(1);
  });
});
