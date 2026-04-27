import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so the runtime tests stay hermetic. Each
// test asserts on the resolved system / user strings handed to the
// provider layer.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (): Promise<LlmResult> => ({
      text: "stubbed-response",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  ),
}));

import { callLlm } from "../src/llm/providers/index.ts";
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

describe("agent prompt source: string and function forms (llm parity)", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Static string `system` is forwarded unchanged
   * @preconditions agent({ system: "static" })
   * @expectedResult callLlm receives system === "static"
   */
  test("system as static string", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("system-string")
          .from(simple("body"))
          .to(
            agent({
              system: "static system prompt",
              model: "anthropic:claude-opus-4-7",
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].system).toBe("static system prompt");
  });

  /**
   * @case Function `system` runs against the exchange and resolves to the returned string
   * @preconditions agent({ system: (exchange) => `Hello ${exchange.body}` })
   * @expectedResult callLlm receives the resolved system string
   */
  test("system as function gets the exchange", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("system-fn")
          .from(simple("Alice"))
          .to(
            agent({
              system: (exchange) => `Hello ${exchange.body as string}`,
              model: "anthropic:claude-opus-4-7",
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].system).toBe("Hello Alice");
  });

  /**
   * @case Static string `user` overrides the body-default fallback
   * @preconditions agent({ user: "fixed user prompt" })
   * @expectedResult callLlm receives user === "fixed user prompt" (not the body)
   */
  test("user as static string overrides body fallback", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("user-string")
          .from(simple("body-text"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              user: "fixed user prompt",
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].user).toBe("fixed user prompt");
  });

  /**
   * @case Function `user` derives the prompt from the exchange
   * @preconditions agent({ user: (exchange) => `q: ${exchange.body}` })
   * @expectedResult callLlm receives the resolved user string
   */
  test("user as function gets the exchange", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("user-fn")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              user: (exchange) => `q: ${exchange.body as string}`,
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].user).toBe("q: hi");
  });

  /**
   * @case Omitting `user` falls back to the body default (regression)
   * @preconditions agent without `user`; body is a string
   * @expectedResult callLlm receives user === body string
   */
  test("user omitted falls back to body (regression)", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("user-default")
          .from(simple("body-as-prompt"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" })),
      )
      .build();

    await t.test();
    expect(callLlmMock.mock.calls[0][0].user).toBe("body-as-prompt");
  });

  /**
   * @case Function-form `system` that returns "" throws at dispatch
   * @preconditions system: () => "" (empty resolved value)
   * @expectedResult Dispatch rejects with RC5003 and never calls the provider
   */
  test("function-form system returning empty string throws at dispatch", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("system-empty-fn")
          .from(simple("hi"))
          .to(
            agent({
              system: () => "",
              model: "anthropic:claude-opus-4-7",
            }),
          ),
      )
      .build();

    await t.test();
    expect(t.errors[0]?.message).toMatch(/system.*resolved to an empty string/);
    expect(callLlmMock).not.toHaveBeenCalled();
  });
});
