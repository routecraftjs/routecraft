import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin, type Block } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => {
    return { text: "ok", finishReason: "stop", stepsCount: 1 };
  }),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

describe("agent blocks: lifetime semantics", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Default lifetime ("dispatch") re-invokes the resolver every dispatch
   * @preconditions Inject block whose value is a counting function; the route processes two messages
   * @expectedResult Resolver fires once per dispatch (2 calls for 2 dispatches)
   */
  test('default lifetime "dispatch" runs the resolver every dispatch', async () => {
    const sink = spy();
    let calls = 0;
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("lifetime-dispatch")
          .from(simple(["a", "b"]))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: [
                {
                  name: "fresh",
                  mode: "inject",
                  value: () => {
                    calls += 1;
                    return `call ${calls}`;
                  },
                },
              ],
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(calls).toBe(2);
  });

  /**
   * @case lifetime: "context" caches the resolver output across dispatches in the same context
   * @preconditions Inject block with lifetime: "context"; route processes two messages in one TestContext
   * @expectedResult Resolver runs exactly once even though the route dispatches twice
   */
  test('lifetime "context" caches the resolved value across dispatches', async () => {
    const sink = spy();
    let calls = 0;
    // Define the block *outside* the agent options so the same Block
    // reference is used across dispatches (cache key is block identity).
    const cached: Block = {
      name: "tenant",
      mode: "inject",
      lifetime: "context",
      value: () => {
        calls += 1;
        return `value-${calls}`;
      },
    };
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("lifetime-context")
          .from(simple(["a", "b"]))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: [cached],
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(calls).toBe(1);
  });
});
