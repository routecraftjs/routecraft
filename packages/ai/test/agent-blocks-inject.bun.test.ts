import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

let capturedSystem: string | undefined;

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (params: { system: string }): Promise<LlmResult> => {
    capturedSystem = params.system;
    return { text: "ok", finishReason: "stop", stepsCount: 1 };
  }),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

describe('agent blocks: mode: "inject" concatenates content into the system prompt', () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    capturedSystem = undefined;
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Static-string inject blocks land in the system prompt in declared order with `## <name>` headings
   * @preconditions Two inject blocks declared on the agent
   * @expectedResult The captured system prompt opens with the agent's own system and then carries `## <name>` blocks in order
   */
  test("static inject blocks land in the system prompt in order", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("inject-order")
          .from(simple("hi"))
          .to(
            agent({
              system: "You are an analyst.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                first: {
                  mode: "inject",
                  value: "First block content.",
                },
                second: {
                  mode: "inject",
                  value: "Second block content.",
                },
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem!.startsWith("You are an analyst.")).toBe(true);
    expect(capturedSystem).toContain("## first");
    expect(capturedSystem).toContain("First block content.");
    expect(capturedSystem).toContain("## second");
    expect(capturedSystem).toContain("Second block content.");
    const firstIdx = capturedSystem!.indexOf("## first");
    const secondIdx = capturedSystem!.indexOf("## second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  /**
   * @case Function-form resolvers receive (exchange, context, events, client) and their string return lands in the prompt
   * @preconditions Inject block whose value is an async function returning a derived string
   * @expectedResult Captured system prompt carries the function's returned content
   */
  test("function-form inject resolvers run at dispatch", async () => {
    const sink = spy();
    let resolverCalls = 0;
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("inject-fn")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                computed: {
                  mode: "inject",
                  value: async (exchange, _context, events) => {
                    resolverCalls += 1;
                    expect(events).toEqual([]);
                    expect(exchange.id).toBeDefined();
                    return "Derived content.";
                  },
                },
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(resolverCalls).toBe(1);
    expect(capturedSystem).toContain("## computed");
    expect(capturedSystem).toContain("Derived content.");
  });
});
