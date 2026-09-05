import { describe, expect, test } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { buildExtras, buildSdkParams } from "../src/llm/providers/llm-utils.ts";
import { toPromptInput } from "../src/llm/shared.ts";

/**
 * What the SDK hands `onStepFinish` across a tool loop, driven through the
 * real `buildExtras` mapping rather than the scripted harness the session
 * tests use, which never reaches it. The session runtime persists the
 * thread from each step's `response.messages`, so whether that array is
 * the step's own messages or everything generated so far decides whether
 * an interrupted turn keeps its history. Vitest for the reason the sibling
 * SDK test gives: bun shares one module registry and other files mock `ai`.
 */

type Message = { role: string; content: unknown };

/** A model that calls `echo` twice and then answers in text. */
function threeStepModel(): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      if (calls < 3) {
        return {
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${calls}`,
              toolName: "echo",
              input: JSON.stringify({ n: calls }),
            },
          ],
          warnings: [],
        };
      }
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        content: [{ type: "text" as const, text: "done" }],
        warnings: [],
      };
    },
  });
}

describe("onStepFinish carries the whole response thread", () => {
  /**
   * @case Each step's response.messages is cumulative, so the last step seen is the full thread
   * @preconditions A mock model that returns a tool call on its first two calls and text on the third; buildExtras wires onStep; generateText runs the loop
   * @expectedResult onStep fires three times with 2, 4 and 5 response messages, and the final list reads assistant, tool, assistant, tool, assistant, carrying both tool calls and both results
   */
  test("three steps arrive as one growing thread", async () => {
    const seen: Message[][] = [];
    const extras = buildExtras({
      tools: {
        echo: tool({
          description: "Echoes its input",
          inputSchema: z.object({ n: z.number() }),
          execute: async ({ n }) => ({ echoed: n }),
        }),
      },
      stopWhen: stepCountIs(5),
      onStep: async ({ responseMessages }) => {
        seen.push(responseMessages as Message[]);
      },
    });
    const params = buildSdkParams({
      model: threeStepModel(),
      provider: "custom",
      options: { temperature: 0, maxTokens: 16 },
      system: "",
      user: toPromptInput("go"),
      extras,
    });
    const result = await generateText(
      params as Parameters<typeof generateText>[0],
    );
    expect(result.text).toBe("done");
    expect(seen.map((messages) => messages.length)).toEqual([2, 4, 5]);
    expect(seen[2]!.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    const text = JSON.stringify(seen[2]);
    expect(text).toContain("call-1");
    expect(text).toContain("call-2");
    expect(text).toContain('"echoed":1');
    expect(text).toContain('"echoed":2');
  });
});
