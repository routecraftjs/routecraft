import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, agentPlugin, llmPlugin } from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => {
    return { text: "ok", finishReason: "stop", stepsCount: 1 };
  }),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

describe("agent blocks: construction-time validation", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Block names starting with the reserved `_block_` prefix are rejected (RC5026)
   * @preconditions Agent declares a block named `_block_load_x`
   * @expectedResult agent() construction throws an RC5026-shaped error
   */
  test("rejects block names with the reserved `_block_` prefix", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: [{ name: "_block_load_x", mode: "inject", value: "y" }],
      }),
    ).toThrow(/reserved for synthetic loader tools/);
  });

  /**
   * @case Duplicate block names within the same agent are rejected (RC5026)
   * @preconditions Agent declares two blocks with the same name
   * @expectedResult agent() construction throws
   */
  test("rejects duplicate block names within one agent", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: [
          { name: "dup", mode: "inject", value: "a" },
          { name: "dup", mode: "inject", value: "b" },
        ],
      }),
    ).toThrow(/duplicate name/);
  });

  /**
   * @case Progressive-mode blocks must carry a description (RC5027)
   * @preconditions Agent declares a progressive block with no description
   * @expectedResult agent() construction throws explaining the requirement
   */
  test("rejects progressive blocks missing a description", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: [{ name: "research", mode: "progressive", value: "body" }],
      }),
    ).toThrow(/progressive-mode blocks require a non-empty "description"/);
  });

  /**
   * @case Invalid mode value rejected (RC5027)
   * @preconditions Agent declares a block with mode: "bogus"
   * @expectedResult agent() construction throws
   */
  test('rejects invalid "mode" value', () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        // @ts-expect-error -- testing runtime validation of an invalid mode
        blocks: [{ name: "x", mode: "bogus", value: "y" }],
      }),
    ).toThrow(/"mode" must be "inject" or "progressive"/);
  });

  /**
   * @case Non-string, non-function value rejected (RC5027)
   * @preconditions Agent declares a block whose value is a number
   * @expectedResult agent() construction throws
   */
  test('rejects non-string, non-function "value"', () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        // @ts-expect-error -- testing runtime validation of an invalid value
        blocks: [{ name: "x", mode: "inject", value: 42 }],
      }),
    ).toThrow(/"value" must be a string or a function/);
  });

  /**
   * @case A function-form resolver that throws raises RC5025 at dispatch
   * @preconditions Inject block whose value throws
   * @expectedResult The dispatch propagates an error message naming the block
   */
  test("inject resolver throw aborts the dispatch with RC5025", async () => {
    const sink = spy();
    const errors: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({}),
        ],
      })
      .routes(
        craft()
          .id("inject-throws")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: [
                {
                  name: "broken",
                  mode: "inject",
                  value: () => {
                    throw new Error("boom");
                  },
                },
              ],
            }),
          )
          .to(sink),
      )
      .build();
    t.ctx.on(
      "route:inject-throws:exchange:failed" as never,
      ({ details }: { details: { error: unknown } }) => {
        errors.push(details.error);
      },
    );
    await t.test();
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toMatch(/Agent block "broken"/);
  });

  /**
   * @case A user tool registered under the reserved `_block_` prefix is rejected at dispatch (RC5026)
   * @preconditions Plugin registers an fn named `_block_load_evil`; agent references it
   * @expectedResult Dispatch raises an error explaining the prefix is reserved
   */
  test("user tools cannot use the reserved `_block_` prefix", async () => {
    const sink = spy();
    const errors: unknown[] = [];
    const { tools } = await import("../src/index.ts");
    const { z } = await import("zod");
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            functions: {
              _block_load_evil: {
                description: "should be rejected",
                input: z.object({}),
                handler: async () => "nope",
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("collide")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["_block_load_evil"]),
            }),
          )
          .to(sink),
      )
      .build();
    t.ctx.on(
      "route:collide:exchange:failed" as never,
      ({ details }: { details: { error: unknown } }) => {
        errors.push(details.error);
      },
    );
    await t.test();
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toMatch(
      /reserved for synthetic block loaders/,
    );
  });
});
