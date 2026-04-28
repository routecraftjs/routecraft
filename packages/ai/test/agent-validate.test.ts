import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin, type AgentResult } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM provider so the validator can drive deterministic
// retry behaviour without hitting a real model. Each test installs
// its own queue of responses via `queueResponses(...)` and
// `callLlm` / `streamLlm` consume one entry per invocation.
let responseQueue: LlmResult[] = [];

function queueResponses(...rs: LlmResult[]): void {
  responseQueue = [...rs];
}

function nextResponse(): LlmResult {
  const r = responseQueue.shift();
  if (!r) throw new Error("test bug: callLlm invoked beyond queued responses");
  return r;
}

vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(async (): Promise<LlmResult> => nextResponse()),
  streamLlm: vi.fn(
    async (params: {
      onDelta: (d: { type: string; text: string }) => void | Promise<void>;
    }): Promise<LlmResult> => {
      await params.onDelta({ type: "text-delta", text: "tok" });
      return nextResponse();
    },
  ),
}));

describe("agent.validate: pre-finish hook with corrective retry", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    responseQueue = [];
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case validate returns void, dispatch resolves on the first call
   * @preconditions Single response; validate accepts unconditionally
   * @expectedResult AgentResult.text is the first response; validate ran exactly once
   */
  test("validate returning void accepts the result on the first call", async () => {
    queueResponses({
      text: "first",
      finishReason: "stop",
      stepsCount: 1,
    });
    const validate = vi.fn(() => undefined);
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("v-accept")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              validate,
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.text).toBe("first");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  /**
   * @case validate returns a string on the first call, accepts on the retry
   * @preconditions Two queued responses; validate rejects the first, accepts the second
   * @expectedResult Final AgentResult.text is the second response; validate ran twice; second call sees the corrective user message
   */
  test("validate returning a string triggers a retry with the corrective message", async () => {
    queueResponses(
      {
        text: "missing tool call",
        finishReason: "stop",
        stepsCount: 1,
        responseMessages: [{ role: "assistant", content: "missing tool call" }],
      },
      {
        text: "now with the tool call",
        finishReason: "stop",
        stepsCount: 1,
      },
    );
    const validateCalls: AgentResult[] = [];
    const validate = vi.fn((result: AgentResult) => {
      validateCalls.push(result);
      return validateCalls.length === 1
        ? "you must call send_email"
        : undefined;
    });

    const { callLlm } =
      (await import("../src/llm/providers/index.ts")) as unknown as {
        callLlm: ReturnType<typeof vi.fn>;
      };

    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("v-retry")
          .from(simple("original-user-prompt"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              validate,
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();

    const r = sink.received[0]!.body as AgentResult;
    expect(r.text).toBe("now with the tool call");
    expect(validate).toHaveBeenCalledTimes(2);
    // First call uses the raw string user prompt.
    expect(callLlm.mock.calls[0]?.[0]).toMatchObject({
      user: "original-user-prompt",
    });
    // Second call uses an array of messages: original user, prior assistant
    // response, validator-corrective user message.
    const secondUser = (
      callLlm.mock.calls[1]?.[0] as {
        user: unknown;
      }
    ).user;
    expect(Array.isArray(secondUser)).toBe(true);
    const arr = secondUser as { role: string; content: string }[];
    expect(arr[0]).toEqual({ role: "user", content: "original-user-prompt" });
    // Middle entry is the SDK response message we forwarded.
    expect(arr[1]).toEqual({ role: "assistant", content: "missing tool call" });
    expect(arr[arr.length - 1]).toEqual({
      role: "user",
      content: "Validator: you must call send_email",
    });
  });

  /**
   * @case validate exhausts maxTurns; dispatch fails with RC5003 carrying the last validator message
   * @preconditions maxTurns=2 with 2 queued responses; validate always rejects
   * @expectedResult Promise rejects with RC5003; message mentions maxTurns and the last validator message
   */
  test("validate that never accepts fails the dispatch when maxTurns is exhausted", async () => {
    queueResponses(
      {
        text: "r1",
        finishReason: "stop",
        stepsCount: 1,
        responseMessages: [{ role: "assistant", content: "r1" }],
      },
      {
        text: "r2",
        finishReason: "stop",
        stepsCount: 1,
        responseMessages: [{ role: "assistant", content: "r2" }],
      },
    );
    const validate = vi.fn(() => "still not good enough");
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("v-exhaust")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              maxTurns: 2,
              validate,
            }),
          ),
      )
      .build();

    const errors: unknown[] = [];
    t.ctx.on(
      "route:v-exhaust:agent:error" as never,
      ({ details }: { details: { error: unknown } }) => {
        errors.push(details.error);
      },
    );

    await t.test();
    expect(errors).toHaveLength(1);
    const err = errors[0] as Error;
    expect(err.message).toMatch(/maxTurns \(2\)/);
    expect(err.message).toMatch(/still not good enough/);
  });

  /**
   * @case AgentResult.toolCalls is cumulative across validate retries
   * @preconditions Two queued responses, each with a different tool call
   * @expectedResult Final AgentResult.toolCalls contains tool calls from BOTH calls in order
   */
  test("toolCalls accumulate across validate retries", async () => {
    queueResponses(
      {
        text: "first",
        finishReason: "stop",
        stepsCount: 1,
        toolCalls: [
          {
            toolCallId: "c1",
            toolName: "search",
            input: { q: "x" },
            output: { hits: 1 },
          },
        ],
        responseMessages: [{ role: "assistant", content: "first" }],
      },
      {
        text: "second",
        finishReason: "stop",
        stepsCount: 1,
        toolCalls: [
          {
            toolCallId: "c2",
            toolName: "send_email",
            input: { to: "x@y" },
            output: { ok: true },
          },
        ],
      },
    );
    let calls = 0;
    const validate = (result: AgentResult): string | void => {
      calls += 1;
      if (calls === 1) return "must call send_email";
      // Accept once both tools have been invoked.
      const names = (result.toolCalls ?? []).map((c) => c.toolName);
      if (!names.includes("send_email")) return "still missing send_email";
      return undefined;
    };
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("v-accumulate")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              validate,
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.toolCalls?.map((c) => c.toolName)).toEqual([
      "search",
      "send_email",
    ]);
  });

  /**
   * @case validate runs in the streaming path with the same retry semantics
   * @preconditions Two queued responses; onDelta listener attached; validate rejects then accepts
   * @expectedResult Final text is the second response; onDelta saw deltas from both calls
   */
  test("validate retries also work under the streaming path", async () => {
    queueResponses(
      {
        text: "first",
        finishReason: "stop",
        stepsCount: 1,
        responseMessages: [{ role: "assistant", content: "first" }],
      },
      { text: "final", finishReason: "stop", stepsCount: 1 },
    );
    let calls = 0;
    const validate = () => (++calls === 1 ? "retry please" : undefined);
    const onDelta = vi.fn();
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("v-stream")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              validate,
              onDelta,
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.text).toBe("final");
    // onDelta fired once per stream call; validate retried once so we expect two delta events.
    expect(onDelta).toHaveBeenCalledTimes(2);
  });
});
