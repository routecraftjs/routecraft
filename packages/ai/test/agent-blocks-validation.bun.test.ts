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
        blocks: { _block_load_x: { mode: "inject", value: "y" } },
      }),
    ).toThrow(/reserved for synthetic block tools/);
  });

  /**
   * @case Reservation covers the whole `_block_` namespace, not just `_block_load_`
   * @preconditions Agent declares a block named `_block_state_x` (no current loader uses this kind, but the namespace is reserved)
   * @expectedResult agent() construction throws so future synthetic-tool kinds (e.g. unloaders, state probes) can land without a separate breaking reservation
   */
  test("reserves the entire `_block_` namespace, not just `_block_load_`", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: { _block_state_x: { mode: "inject", value: "y" } },
      }),
    ).toThrow(/reserved for synthetic block tools/);
  });

  /**
   * @case Empty-string block name rejected (RC5026)
   * @preconditions Agent declares a block whose key is the empty string
   * @expectedResult agent() construction throws
   */
  test("rejects empty-string block name", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: { "": { mode: "inject", value: "y" } },
      }),
    ).toThrow(/block name must be a non-empty string/);
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
        blocks: { research: { mode: "progressive", value: "body" } },
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
        blocks: { x: { mode: "bogus", value: "y" } },
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
        blocks: { x: { mode: "inject", value: 42 } },
      }),
    ).toThrow(/"value" must be a string or a function/);
  });

  /**
   * @case Setting a block name to `false` is accepted at construction
   * @preconditions Agent declares `blocks: { something: false }` to remove a default
   * @expectedResult agent() construction does NOT throw; the entry is silently ignored if no matching default exists
   */
  test('accepts "false" as a value for removing a defaulted block', () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: { safety: false },
      }),
    ).not.toThrow();
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
              blocks: {
                broken: {
                  mode: "inject",
                  value: () => {
                    throw new Error("boom");
                  },
                },
              },
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
      /reserved for synthetic block tools/,
    );
  });
});
