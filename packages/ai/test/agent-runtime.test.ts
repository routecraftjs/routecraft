import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { z } from "zod";
import {
  agent,
  agentPlugin,
  defaultFns,
  llmPlugin,
  tools,
  type AgentResult,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so the runtime tests stay hermetic. Each
// happy-path test asserts on the dispatcher args (tools, output,
// stopWhen, modelId, etc.) and controls the response shape.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (): Promise<LlmResult> => ({
      text: "stubbed-response",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  ),
}));

import { callLlm } from "../src/llm/providers/index.ts";
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

describe("agent runtime: tool wiring through callLlm", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({
      text: "stubbed-response",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Agent without tools dispatches callLlm without `tools` or `stopWhen`
   * @preconditions Inline agent({ system, model }) without a tools field
   * @expectedResult callLlm receives the prompt only; no tools, stopWhen, or output
   */
  test("agent without tools omits tool wiring", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("no-tools")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    const args = callLlmMock.mock.calls[0][0];
    expect(args.tools).toBeUndefined();
    expect(args.stopWhen).toBeUndefined();
    expect(args.output).toBeUndefined();
    expect(args.modelId).toBe("claude-opus-4-7");
  });

  /**
   * @case Agent with one fn tool passes a single Vercel tool to callLlm with stopWhen
   * @preconditions agentPlugin functions: { currentTime }; agent.tools = tools(["currentTime"])
   * @expectedResult callLlm receives tools.currentTime (Vercel tool object) and a stopWhen
   */
  test("agent with one fn tool passes the tool map to callLlm", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ...defaultFns } }),
        ],
      })
      .routes(
        craft()
          .id("with-tool")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["currentTime"]),
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    const args = callLlmMock.mock.calls[0][0];
    expect(args.tools).toBeDefined();
    expect(Object.keys(args.tools as Record<string, unknown>)).toEqual([
      "currentTime",
    ]);
    expect(args.stopWhen).toBeDefined();
  });

  /**
   * @case maxSteps shorthand resolves to a stopWhen value
   * @preconditions agent.maxSteps = 3
   * @expectedResult callLlm receives a stopWhen (we don't unpack the SDK helper's shape; presence is enough)
   */
  test("maxSteps shorthand produces a stopWhen", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ...defaultFns } }),
        ],
      })
      .routes(
        craft()
          .id("maxsteps")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["currentTime"]),
              maxSteps: 3,
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].stopWhen).toBeDefined();
  });

  /**
   * @case Agent with output schema passes an `output` spec to callLlm
   * @preconditions agent.output = z.object({ summary: z.string() })
   * @expectedResult callLlm receives a non-undefined `output`
   */
  test("agent({ output }) passes the output spec through callLlm", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("with-output")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              output: z.object({ summary: z.string() }),
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].output).toBeDefined();
  });

  /**
   * @case AgentResult propagates `reasoning` from LlmResult.reasoning
   * @preconditions Stubbed callLlm returns reasoning = "thinking out loud"
   * @expectedResult Downstream body has body.reasoning === "thinking out loud"
   */
  test("AgentResult propagates reasoning when the provider supplies it", async () => {
    callLlmMock.mockResolvedValueOnce({
      text: "final answer",
      reasoning: "thinking out loud",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("reasoning")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" }))
          .to(sink),
      )
      .build();

    await t.test();
    const body = sink.received[0].body as AgentResult;
    expect(body.text).toBe("final answer");
    expect(body.reasoning).toBe("thinking out loud");
  });

  /**
   * @case AgentResult propagates `output` from LlmResult.output
   * @preconditions Stubbed callLlm returns output = { summary: "..." }
   * @expectedResult Downstream body has body.output === { summary: "..." }
   */
  test("AgentResult propagates structured output", async () => {
    callLlmMock.mockResolvedValueOnce({
      text: "raw",
      output: { summary: "the summary" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("structured")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              output: z.object({ summary: z.string() }),
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    const body = sink.received[0].body as AgentResult;
    expect(body.output).toEqual({ summary: "the summary" });
  });

  /**
   * @case Agent inherits defaultOptions.tools when tools field is omitted
   * @preconditions agentPlugin.defaultOptions.tools = tools(["currentTime"]); agent omits tools
   * @expectedResult callLlm receives the inherited tool map
   */
  test("agent inherits defaultOptions.tools when its own tools is omitted", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            functions: { ...defaultFns },
            defaultOptions: { tools: tools(["currentTime"]) },
          }),
        ],
      })
      .routes(
        craft()
          .id("inherits-tools")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" })),
      )
      .build();

    await t.test();
    const args = callLlmMock.mock.calls[0][0];
    expect(Object.keys(args.tools as Record<string, unknown>)).toEqual([
      "currentTime",
    ]);
  });

  /**
   * @case Explicit tools on the agent override defaultOptions.tools entirely
   * @preconditions defaultOptions.tools includes only "currentTime"; agent.tools includes only "randomUuid"
   * @expectedResult callLlm receives only "randomUuid"
   */
  test("per-agent tools overrides defaultOptions.tools", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            functions: { ...defaultFns },
            defaultOptions: { tools: tools(["currentTime"]) },
          }),
        ],
      })
      .routes(
        craft()
          .id("override-tools")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["randomUuid"]),
            }),
          ),
      )
      .build();

    await t.test();
    const args = callLlmMock.mock.calls[0][0];
    expect(Object.keys(args.tools as Record<string, unknown>)).toEqual([
      "randomUuid",
    ]);
  });
});
