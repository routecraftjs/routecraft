import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  llmPlugin,
  skills,
  type AgentResult,
} from "../src/index.ts";
import { flattenBlocks } from "../src/block/resolve.ts";
import type { LlmResult, LlmToolCallSummary } from "../src/llm/types.ts";

// Captures what the provider layer received and simulates the model
// invoking every synthetic loader tool present, so a test can assert
// both the flattened loader-tool names and the resulting blocksLoaded.
let captured: { system?: string; tools?: Record<string, unknown> } = {};

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(
    async (params: {
      system: string;
      tools?: Record<string, unknown>;
    }): Promise<LlmResult> => {
      captured = { system: params.system, tools: params.tools };
      const toolCalls: LlmToolCallSummary[] = Object.keys(params.tools ?? {})
        .filter((n) => n.startsWith("_block_load_"))
        .map((toolName, i) => ({
          toolCallId: `loader-${i}`,
          toolName,
          input: {},
          output: `loaded ${toolName}`,
        }));
      return { text: "done", finishReason: "stop", toolCalls };
    },
  ),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

describe("agent blocks: nested named groups", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    captured = {};
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case flattenBlocks joins a nested group's leaf names with `__` depth-first, preserving order
   * @preconditions A blocks tree with one group of two leaves plus a top-level leaf
   * @expectedResult The flattened map keys are skills__a, skills__b, tone in declared order
   */
  test("flattenBlocks qualifies nested names with the `__` separator", () => {
    const flat = flattenBlocks({
      skills: {
        a: { mode: "inject", value: "A" },
        b: { mode: "inject", value: "B" },
      },
      tone: { mode: "inject", value: "T" },
    });
    expect([...flat.keys()]).toEqual(["skills__a", "skills__b", "tone"]);
  });

  /**
   * @case Two blocks that flatten to the same canonical name are rejected (RC5026)
   * @preconditions A flat block `skills__onboarding` and a group `skills` with leaf `onboarding`
   * @expectedResult flattenBlocks throws explaining the collision
   */
  test("flattenBlocks rejects a flat/nested name collision", () => {
    expect(() =>
      flattenBlocks({
        skills__onboarding: { mode: "inject", value: "flat" },
        skills: { onboarding: { mode: "inject", value: "nested" } },
      }),
    ).toThrow(/resolve to the same name after flattening/);
  });

  /**
   * @case A progressive group surfaces one loader tool per leaf, named with the flattened path
   * @preconditions Agent declares a `skills` group of two progressive leaves
   * @expectedResult Captured tools carry `_block_load_skills__onboarding` / `__refunds`; blocksLoaded reports the flattened names
   */
  test("progressive group flattens into _block_load_<group>__<leaf> tools", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("nested-progressive")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                skills: {
                  onboarding: {
                    description: "How to onboard.",
                    mode: "progressive",
                    value: "<onboarding>",
                  },
                  refunds: {
                    description: "How to refund.",
                    mode: "progressive",
                    value: "<refunds>",
                  },
                },
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(Object.keys(captured.tools ?? {}).sort()).toEqual([
      "_block_load_skills__onboarding",
      "_block_load_skills__refunds",
    ]);
    const result = sink.received[0]!.body as AgentResult;
    expect(result.blocksLoaded?.map((b) => b.blockName).sort()).toEqual([
      "skills__onboarding",
      "skills__refunds",
    ]);
  });

  /**
   * @case An inject leaf inside a group lands in the system prompt under its flattened heading
   * @preconditions Agent declares a `policies` group with one inject leaf
   * @expectedResult Captured system prompt carries `## policies__tone` and the leaf body
   */
  test("inject group leaf renders ## <group>__<leaf> in the system prompt", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("nested-inject")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                policies: {
                  tone: { mode: "inject", value: "Be terse." },
                },
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(captured.system).toContain("## policies__tone");
    expect(captured.system).toContain("Be terse.");
  });

  /**
   * @case skills({ source }) slots in directly as a group value with no spread
   * @preconditions A skills folder of two markdown files used as `blocks: { skills: await skills(...) }`
   * @expectedResult Each skill becomes a flattened progressive loader tool under the `skills` namespace
   */
  test("skills() used as a group value namespaces every skill under the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rc-skills-"));
    try {
      await writeFile(
        join(dir, "onboarding.md"),
        `---\nname: onboarding\ndescription: How to onboard a customer.\n---\nOnboarding steps.\n`,
      );
      await writeFile(
        join(dir, "refunds.md"),
        `---\nname: refunds\ndescription: How to process a refund.\n---\nRefund steps.\n`,
      );

      const sink = spy();
      t = await testContext()
        .with({
          plugins: [
            llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          ],
        })
        .routes(
          craft()
            .id("skills-group")
            .from(simple("hi"))
            .to(
              agent({
                system: "x",
                model: "anthropic:claude-opus-4-7",
                blocks: {
                  skills: await skills({ source: dir }),
                },
              }),
            )
            .to(sink),
        )
        .build();

      await t.test();
      expect(Object.keys(captured.tools ?? {}).sort()).toEqual([
        "_block_load_skills__onboarding",
        "_block_load_skills__refunds",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case A reserved `_block_` prefix on a nested leaf is rejected at construction (RC5026)
   * @preconditions Agent declares a group `skills` whose leaf is named `_block_load_x`
   * @expectedResult agent() construction throws naming the flattened block
   */
  test("rejects a reserved-prefix name nested inside a group", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: {
          skills: { _block_load_x: { mode: "inject", value: "y" } },
        },
      }),
    ).toThrow(/reserved for synthetic block tools/);
  });

  /**
   * @case An invalid nested leaf is rejected at construction with its flattened name (RC5027)
   * @preconditions Agent declares a group `skills` whose leaf is progressive but missing a description
   * @expectedResult agent() construction throws referencing "skills__research"
   */
  test("rejects an invalid nested leaf and names it by its flattened path", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: {
          skills: { research: { mode: "progressive", value: "body" } },
        },
      }),
    ).toThrow(/Agent block "skills__research"/);
  });

  /**
   * @case A per-agent group replaces a default group of the same name (per-name merge)
   * @preconditions agentPlugin default `skills` group with leaf `legacy`; agent supplies `skills` with leaf `fresh`
   * @expectedResult Only the per-agent group's loader tool is present after merge
   */
  test("per-agent group replaces a default group by name", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                skills: {
                  legacy: {
                    description: "Old skill.",
                    mode: "progressive",
                    value: "<legacy>",
                  },
                },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("merge-replace")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                skills: {
                  fresh: {
                    description: "New skill.",
                    mode: "progressive",
                    value: "<fresh>",
                  },
                },
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(Object.keys(captured.tools ?? {})).toEqual([
      "_block_load_skills__fresh",
    ]);
  });

  /**
   * @case Setting a default group's name to `false` removes the whole group for that agent
   * @preconditions agentPlugin default `skills` group; agent sets `skills: false`
   * @expectedResult No loader tools are present after merge
   */
  test("`group: false` removes a default group wholesale", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            defaultOptions: {
              blocks: {
                skills: {
                  legacy: {
                    description: "Old skill.",
                    mode: "progressive",
                    value: "<legacy>",
                  },
                },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("merge-remove")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: { skills: false },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(
      Object.keys(captured.tools ?? {}).filter((n) =>
        n.startsWith("_block_load_"),
      ),
    ).toEqual([]);
  });

  /**
   * @case A nested name that flattens into the reserved `_block_` namespace is rejected at construction
   * @preconditions Agent declares a group `_block` with a leaf `x`, flattening to `_block__x`
   * @expectedResult agent() throws RC5026 even though neither segment alone starts with `_block_`
   */
  test("rejects a nested name that forges the reserved prefix when flattened", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: { _block: { x: { mode: "inject", value: "y" } } },
      }),
    ).toThrow(/reserved for synthetic block tools/);
  });

  /**
   * @case A leaf that omits `mode` is reported as a missing-mode error, not recursed as a group
   * @preconditions Agent declares a block whose body has a `value` but no `mode`
   * @expectedResult agent() throws the precise "mode must be inject/progressive" error naming the block, not a phantom `<name>__value`
   */
  test("reports a forgotten mode precisely instead of treating the leaf as a group", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        // @ts-expect-error -- runtime guard against a leaf missing `mode`
        blocks: { tone: { value: "Be terse." } },
      }),
    ).toThrow(/Agent block "tone": "mode" must be "inject" or "progressive"/);
  });

  /**
   * @case A flat name colliding with a nested path is rejected at construction, not deferred to dispatch
   * @preconditions Agent declares a flat `skills__onboarding` and a group `skills` with leaf `onboarding`
   * @expectedResult agent() throws RC5026 synchronously at construction
   */
  test("rejects a flat/nested flatten collision at construction time", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: {
          skills__onboarding: { mode: "inject", value: "a" },
          skills: { onboarding: { mode: "inject", value: "b" } },
        },
      }),
    ).toThrow(/resolve to the same name after flattening/);
  });

  /**
   * @case A progressive block whose name breaks the provider tool-name charset is rejected at construction
   * @preconditions Agent declares a progressive block named "q&a"
   * @expectedResult agent() throws RC5027 explaining the loader-tool charset, instead of failing at the provider on dispatch
   */
  test("rejects a progressive block name that is not provider tool-name safe", () => {
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: {
          "q&a": { mode: "progressive", description: "d", value: "v" },
        },
      }),
    ).toThrow(/must match/);
  });

  /**
   * @case A progressive loader-tool name over 64 characters is rejected at construction
   * @preconditions A group + leaf whose flattened `_block_load_<name>` exceeds the provider limit
   * @expectedResult agent() throws RC5027 naming the length, instead of failing at the provider on dispatch
   */
  test("rejects a progressive block whose loader tool name exceeds 64 chars", () => {
    const longLeaf = "a".repeat(60);
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: {
          group: {
            [longLeaf]: { mode: "progressive", description: "d", value: "v" },
          },
        },
      }),
    ).toThrow(/over the provider limit of 64/);
  });

  /**
   * @case A cyclic blocks tree is rejected rather than recursed without bound
   * @preconditions A group object that contains itself
   * @expectedResult agent() throws RC5026 ("cycle") instead of a RangeError stack overflow
   */
  test("rejects a cyclic blocks tree instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() =>
      agent({
        system: "x",
        model: "anthropic:claude-opus-4-7",
        blocks: { x: cyclic as never },
      }),
    ).toThrow(/cycle/);
  });
});
