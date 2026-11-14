import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, noop, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { CallLlmParams } from "../src/llm/providers/llm-utils.ts";
import type { LlmOptions, LlmResult } from "../src/llm/types.ts";
import type { AgentOptions } from "../src/agent/types.ts";

// Stubbed at the providers barrel: these tests are about what the two
// destinations ask the provider for and what they make of its answer.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
  streamLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
}));

const { callLlm } = await import("../src/llm/providers/index.ts");
const callLlmMock = callLlm as unknown as ReturnType<typeof mock>;
const { agent, agentPlugin, llm, llmPlugin } = await import("../src/index.ts");
const { resolveSampling } = await import("../src/llm/shared.ts");
const { assertNotCutOffEmpty } = await import("../src/llm/cut-off.ts");

const MODEL = "anthropic:claude-test";
const BODY = "the body itself";

type SyncAgentOptions = AgentOptions & { stream?: false };

/** The params object the only model call received. */
function dispatched(): CallLlmParams {
  const params = callLlmMock.mock.calls[0]?.[0] as CallLlmParams | undefined;
  if (!params) throw new Error("callLlm was not dispatched");
  return params;
}

describe("the default output cap and reasoning", () => {
  /**
   * @case A call that asks the model to think gets no framework output cap
   * @preconditions resolveSampling over each thinking level with no maxTokens
   * @expectedResult maxTokens is absent, so the provider's own maximum applies
   */
  test("a thinking level lifts the default cap", () => {
    for (const reasoning of ["low", "medium", "high"] as const) {
      expect(resolveSampling({ reasoning }).maxTokens).toBeUndefined();
    }
  });

  /**
   * @case A call that does not ask the model to think keeps the classic cap
   * @preconditions resolveSampling with no reasoning, and with reasoning "none"
   * @expectedResult maxTokens is 1024 in both
   */
  test("no reasoning and reasoning none keep the default cap", () => {
    expect(resolveSampling({}).maxTokens).toBe(1024);
    expect(resolveSampling({ reasoning: "none" }).maxTokens).toBe(1024);
  });

  /**
   * @case An authored cap is never lifted
   * @preconditions resolveSampling with reasoning "high" and maxTokens 256
   * @expectedResult maxTokens is 256
   */
  test("an authored cap wins over the lift", () => {
    expect(
      resolveSampling({ reasoning: "high", maxTokens: 256 }).maxTokens,
    ).toBe(256);
  });
});

describe("assertNotCutOffEmpty", () => {
  const cutOff = (extra: Partial<LlmResult> = {}): LlmResult => ({
    text: "",
    finishReason: "length",
    ...extra,
  });

  /**
   * @case A call cut off with nothing in it is refused, for both cut-off reasons
   * @preconditions Empty text, no tool calls, no output, finishReason length or content-filter
   * @expectedResult AI1020, with the spent output tokens in the message when usage reports them
   */
  test("an empty cut-off call is AI1020", () => {
    expect(() =>
      assertNotCutOffEmpty(cutOff({ usage: { outputTokens: 1024 } }), MODEL),
    ).toThrow(
      expect.objectContaining({
        rc: "AI1020",
        message: expect.stringContaining("after 1024 output tokens"),
      }),
    );
    expect(() =>
      assertNotCutOffEmpty(cutOff({ finishReason: "content-filter" }), MODEL),
    ).toThrow(
      expect.objectContaining({
        rc: "AI1020",
        message: expect.stringContaining("content filter"),
      }),
    );
  });

  /**
   * @case Whitespace is not an answer
   * @preconditions Text of spaces and a newline, finishReason length
   * @expectedResult AI1020
   */
  test("whitespace-only text counts as empty", () => {
    expect(() => assertNotCutOffEmpty(cutOff({ text: " \n" }), MODEL)).toThrow(
      expect.objectContaining({ rc: "AI1020" }),
    );
  });

  /**
   * @case A call that produced something, or that the model ended itself, passes
   * @preconditions Cut-off calls carrying text, a tool call, or structured output; an empty call that ended "stop"; one with no finish reason
   * @expectedResult None throws
   */
  test("a partial answer and a deliberate empty answer pass", () => {
    const passing: LlmResult[] = [
      cutOff({ text: "partial" }),
      cutOff({
        toolCalls: [{ toolCallId: "c1", toolName: "send", input: {} }],
      }),
      cutOff({ output: { ok: true } }),
      { text: "", finishReason: "stop" },
      { text: "" },
    ];
    for (const result of passing) {
      expect(() => assertNotCutOffEmpty(result, MODEL)).not.toThrow();
    }
  });
});

describe("a cut-off call fails the exchange", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({
      text: "",
      finishReason: "length",
      usage: { outputTokens: 1024 },
    });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const plugins = () => [
    llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
    agentPlugin(),
  ];

  /**
   * @case An agent turn cut off before any text or tool call fails instead of reading as a reply
   * @preconditions agent() whose model call returns empty text with finishReason length
   * @expectedResult The exchange fails with AI1020, route:agent:error fires and route:agent:finished does not
   */
  test("agent() fails with AI1020 and reports an error, not a finish", async () => {
    const events: string[] = [];
    t = await testContext()
      .with({ plugins: plugins() })
      .routes(
        craft()
          .id("cut-off-agent")
          .from(simple("hi"))
          .to(agent({ model: MODEL, system: "be useful" } as SyncAgentOptions))
          .to(noop()),
      )
      .build();
    t.ctx.on("route:agent:finished" as never, () => {
      events.push("finished");
    });
    t.ctx.on("route:agent:error" as never, () => {
      events.push("error");
    });

    await t.test().catch(() => undefined);

    expect(t.errors[0]?.rc).toBe("AI1020");
    expect(events).toEqual(["error"]);
  });

  /**
   * @case A validator is not asked about a turn that was cut off
   * @preconditions agent() with a validate callback; the model call is cut off empty
   * @expectedResult AI1020 after one model call, and validate never ran
   */
  test("agent() fails before validate is consulted", async () => {
    const validate = mock(() => "try again");
    t = await testContext()
      .with({ plugins: plugins() })
      .routes(
        craft()
          .id("cut-off-validated")
          .from(simple("hi"))
          .to(
            agent({
              model: MODEL,
              system: "be useful",
              validate,
            } as SyncAgentOptions),
          )
          .to(noop()),
      )
      .build();

    await t.test().catch(() => undefined);

    expect(t.errors[0]?.rc).toBe("AI1020");
    expect(validate).not.toHaveBeenCalled();
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case An llm() call cut off before any text fails the same way
   * @preconditions llm() whose model call returns empty text with finishReason length
   * @expectedResult The exchange fails with AI1020
   */
  test("llm() fails with AI1020", async () => {
    t = await testContext()
      .with({ plugins: plugins() })
      .routes(craft().id("cut-off-llm").from(simple("hi")).enrich(llm(MODEL)))
      .build();

    await t.test().catch(() => undefined);

    expect(t.errors[0]?.rc).toBe("AI1020");
  });
});

describe("an explicit user prompt that resolves to nothing", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({ text: "ok" });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const viaLlm = async (options: LlmOptions<string> | undefined) => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft().id("llm-user").from(simple(BODY)).enrich(llm(MODEL, options)),
      )
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);
    return dispatched().user;
  };

  const viaAgent = async (extra: Partial<AgentOptions<string>>) => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin(),
        ],
      })
      .routes(
        craft()
          .id("agent-user")
          .from(simple(BODY))
          .to(
            agent({
              model: MODEL,
              system: "be useful",
              ...extra,
            } as SyncAgentOptions),
          )
          .to(noop()),
      )
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);
    return dispatched().user;
  };

  /**
   * @case llm() uses the body only when user is absent
   * @preconditions llm() with no options over a string body
   * @expectedResult The body is the user prompt
   */
  test("llm(): user absent sends the body", async () => {
    expect(await viaLlm(undefined)).toBe(BODY);
  });

  /**
   * @case llm() sends an empty string as given and never the body
   * @preconditions llm({ user: () => "" }) and llm({ user: "" }) over a string body
   * @expectedResult The user prompt is the empty string
   */
  test("llm(): user resolving to an empty string sends it", async () => {
    expect(await viaLlm({ user: () => "" })).toBe("");
    callLlmMock.mockClear();
    await t!.stop();
    expect(await viaLlm({ user: "" })).toBe("");
  });

  /**
   * @case llm() sends an empty parts array as an empty prompt and never the body
   * @preconditions llm({ user: () => [] }) over a string body
   * @expectedResult The user prompt is the empty string
   */
  test("llm(): user resolving to an empty parts array sends nothing", async () => {
    expect(await viaLlm({ user: () => [] })).toBe("");
  });

  /**
   * @case agent() uses the body only when user is absent
   * @preconditions agent() with no user over a string body
   * @expectedResult The body is the user prompt
   */
  test("agent(): user absent sends the body", async () => {
    expect(await viaAgent({})).toBe(BODY);
  });

  /**
   * @case agent() sends an empty string as given and never the body
   * @preconditions agent({ user: () => "" }) over a string body
   * @expectedResult The user prompt is the empty string
   */
  test("agent(): user resolving to an empty string sends it", async () => {
    expect(await viaAgent({ user: () => "" })).toBe("");
  });

  /**
   * @case agent() sends an empty parts array as an empty prompt and never the body
   * @preconditions agent({ user: () => [] }) over a string body
   * @expectedResult The user prompt is the empty string
   */
  test("agent(): user resolving to an empty parts array sends nothing", async () => {
    expect(await viaAgent({ user: () => [] })).toBe("");
  });
});
