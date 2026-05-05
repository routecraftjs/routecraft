import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, agentPlugin, llmPlugin } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Capture the system prompt the LLM provider received so the test can
// assert that referenced skill content was concatenated into it.
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

describe("agent skills: system-prompt concatenation at dispatch", () => {
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
   * @case Agent with skills: [a, b] sees the skill content concatenated into its system prompt
   * @preconditions Two skills registered; agent declares both
   * @expectedResult Captured system prompt starts with the agent's own and ends with both skill blocks in order
   */
  test("skills are concatenated into the dispatched system prompt", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            skills: {
              "web-search": {
                name: "web-search",
                description: "Search the web",
                content: "Always search before answering.",
              },
              "cite-sources": {
                name: "cite-sources",
                description: "Cite",
                content: "Always cite your sources.",
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("with-skills")
          .from(simple("hi"))
          .to(
            agent({
              system: "You are an analyst.",
              model: "anthropic:claude-opus-4-7",
              skills: ["web-search", "cite-sources"],
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem!.startsWith("You are an analyst.")).toBe(true);
    expect(capturedSystem).toContain("## Skill: web-search");
    expect(capturedSystem).toContain("Always search before answering.");
    expect(capturedSystem).toContain("## Skill: cite-sources");
    expect(capturedSystem).toContain("Always cite your sources.");
    // Order matters: web-search before cite-sources because the agent listed them in that order.
    const wsIdx = capturedSystem!.indexOf("## Skill: web-search");
    const csIdx = capturedSystem!.indexOf("## Skill: cite-sources");
    expect(wsIdx).toBeLessThan(csIdx);
  });

  /**
   * @case Unknown skill name fails the dispatch with RC5003 listing known names
   * @preconditions Agent declares "missing" but only "x" is registered
   * @expectedResult agent:error event fires; message lists known skills
   */
  test("unknown skill name fails dispatch with a clear error", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            skills: {
              x: { name: "x", description: "ok", content: "..." },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("missing-skill")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              skills: ["missing"],
            }),
          ),
      )
      .build();

    const errors: unknown[] = [];
    t.ctx.on(
      "route:missing-skill:exchange:failed" as never,
      ({ details }: { details: { error: unknown } }) => {
        errors.push(details.error);
      },
    );
    await t.test();
    expect(errors.length).toBeGreaterThan(0);
    const msg = (errors[0] as Error).message;
    expect(msg).toMatch(/unknown skill "missing"/);
    expect(msg).toMatch(/Known skill names: "x"/);
  });
});
