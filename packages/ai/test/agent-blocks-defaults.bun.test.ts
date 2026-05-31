import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, agentPlugin, llmPlugin } from "../src/index.ts";
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

describe("agent blocks: defaults merging and removal", () => {
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
   * @case Defaults apply when the agent declares no blocks
   * @preconditions agentPlugin({ defaultOptions: { blocks: { a, b } } }); agent has no blocks
   * @expectedResult Both defaults land in the system prompt in declared order
   */
  test("defaults apply when the agent declares no blocks", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                a: { mode: "inject", value: "A body." },
                b: { mode: "inject", value: "B body." },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("defaults-only")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toContain("## a");
    expect(capturedSystem).toContain("A body.");
    expect(capturedSystem).toContain("## b");
    expect(capturedSystem).toContain("B body.");
    const aIdx = capturedSystem!.indexOf("## a");
    const bIdx = capturedSystem!.indexOf("## b");
    expect(aIdx).toBeLessThan(bIdx);
  });

  /**
   * @case Per-agent block overrides a defaulted entry only by name; non-colliding defaults still apply; new agent keys append
   * @preconditions Defaults { a, b }; agent { a: override, c: new }
   * @expectedResult Final order is a(override), b(default), c(new); b is untouched, a uses the override body
   */
  test("per-agent block overrides default by name; non-colliding defaults still apply", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                a: { mode: "inject", value: "default A" },
                b: { mode: "inject", value: "default B" },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("override-and-extend")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                a: { mode: "inject", value: "OVERRIDE A" },
                c: { mode: "inject", value: "new C" },
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toContain("OVERRIDE A");
    expect(capturedSystem).not.toContain("default A");
    expect(capturedSystem).toContain("default B");
    expect(capturedSystem).toContain("new C");
    const aIdx = capturedSystem!.indexOf("## a");
    const bIdx = capturedSystem!.indexOf("## b");
    const cIdx = capturedSystem!.indexOf("## c");
    // Insertion order: defaults first (a override slots into a's
    // position), then per-agent additions (c) at the end.
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  /**
   * @case A per-agent `false` removes a defaulted block from THIS agent only
   * @preconditions Defaults { safety, style }; agent { safety: false }
   * @expectedResult "safety" does not appear in the system prompt; "style" still does
   */
  test("per-agent false removes a defaulted block from this agent", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                safety: { mode: "inject", value: "Refuse harm." },
                style: { mode: "inject", value: "Be terse." },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("remove-default")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: { safety: false },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).not.toContain("## safety");
    expect(capturedSystem).not.toContain("Refuse harm.");
    expect(capturedSystem).toContain("## style");
    expect(capturedSystem).toContain("Be terse.");
  });

  /**
   * @case Per-agent `false` for a name absent from defaults is a no-op
   * @preconditions No defaults; agent declares { ghost: false } and one real block
   * @expectedResult Agent constructs and dispatches without error; the real block appears; "ghost" does not
   */
  test("per-agent false for a name not in defaults is a no-op", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({}),
        ],
      })
      .routes(
        craft()
          .id("noop-false")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                ghost: false,
                real: { mode: "inject", value: "real body" },
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toContain("## real");
    expect(capturedSystem).not.toContain("## ghost");
  });

  /**
   * @case Two agentPlugin installs merge defaults additively by name
   * @preconditions Two installs each contribute one distinct name in defaultOptions.blocks
   * @expectedResult Both blocks appear in the system prompt; no error at context init
   */
  test("two agentPlugin installs merge defaultOptions.blocks additively", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: { a: { mode: "inject", value: "A body." } },
            },
          }),
          agentPlugin({
            defaultOptions: {
              blocks: { b: { mode: "inject", value: "B body." } },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("two-installs")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(capturedSystem).toContain("A body.");
    expect(capturedSystem).toContain("B body.");
  });

  /**
   * @case Two agentPlugin installs that set the SAME default block name throw at context init
   * @preconditions Two installs each declare a "house-style" block in defaultOptions.blocks
   * @expectedResult build() throws RC5003 explaining that a name can be defined once across installs
   */
  test("colliding default block names across installs throw RC5003", async () => {
    const builder = testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                "house-style": { mode: "inject", value: "Be terse." },
              },
            },
          }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                "house-style": { mode: "inject", value: "Be warm." },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("collision")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
            }),
          )
          .to(spy()),
      );
    await expect(builder.build()).rejects.toThrow(
      /already contains "house-style"/,
    );
  });

  /**
   * @case `false` in `defaultOptions.blocks` is rejected at plugin construction
   * @preconditions agentPlugin({ defaultOptions: { blocks: { safety: false } } })
   * @expectedResult agentPlugin() throws RC5003 explaining the removal sentinel only applies per-agent
   */
  test("false in defaultOptions.blocks is rejected at plugin construction", () => {
    expect(() =>
      agentPlugin({
        defaultOptions: {
          // @ts-expect-error -- runtime guard against a value the type forbids
          blocks: { safety: false },
        },
      }),
    ).toThrow(/cannot be false/);
  });
});
