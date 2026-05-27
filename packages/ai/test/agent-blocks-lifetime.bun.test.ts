import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin, type BlockBody } from "../src/index.ts";
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
              blocks: {
                fresh: {
                  mode: "inject",
                  value: () => {
                    calls += 1;
                    return `call ${calls}`;
                  },
                },
              },
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
    // Define the block body *outside* the agent options so the same
    // BlockBody reference is used across dispatches (cache key is the
    // body's object identity).
    const cached: BlockBody = {
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
              blocks: { tenant: cached },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(calls).toBe(1);
  });

  /**
   * @case Concurrent dispatches against the same context-lifetime block share one in-flight resolution
   * @preconditions Inject block with lifetime: "context"; resolver settles after a short delay; route processes two messages in parallel via simple([...])
   * @expectedResult Resolver fires exactly once even though both dispatches race
   */
  test('lifetime "context" shares the in-flight promise across concurrent dispatches', async () => {
    const sink = spy();
    let calls = 0;
    const cached: BlockBody = {
      mode: "inject",
      lifetime: "context",
      value: async () => {
        calls += 1;
        // A delay forces both dispatches to overlap so the cache must
        // deduplicate by promise sharing, not by serial completion.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "v";
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
          .id("lifetime-concurrent")
          // simple([...]) dispatches every item via Promise.all so two
          // messages race through the agent concurrently.
          .from(simple(["a", "b"]))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: { shared: cached },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();
    expect(calls).toBe(1);
  });

  /**
   * @case A rejected context-lifetime resolution evicts the cache so a subsequent dispatch can retry and succeed
   * @preconditions Same BlockBody resolved twice sequentially via the resolveBlocks API; resolver throws first call, succeeds second
   * @expectedResult The second call invokes the resolver fresh and returns the new value; the resolver ran twice in total
   */
  test('lifetime "context" evicts the cache on rejection', async () => {
    // This test targets the LIFETIME_CACHE eviction contract directly
    // rather than via a route, because route-level dispatches through
    // simple([...]) run concurrently and would share the in-flight
    // promise (covered by the previous test). Eviction is a property
    // between *sequential* dispatches: first throws -> cache cleared
    // -> second sees a fresh slot. Sequential dispatch through routes
    // would require building a chain via direct() forwards, which
    // doesn't add coverage over a direct API call.
    const { resolveBlocks } = await import("../src/block/resolve.ts");
    const { DefaultExchange } = await import("@routecraft/routecraft");
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .build();
    await t.startAndWaitReady();

    let calls = 0;
    const cached: BlockBody = {
      mode: "inject",
      lifetime: "context",
      value: () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return "ok";
      },
    };
    const blocks = { flaky: cached };

    const exchange = new DefaultExchange(t.ctx, { body: "irrelevant" });
    await expect(resolveBlocks(blocks, exchange, t.ctx)).rejects.toThrow(
      /Agent block "flaky".*resolver function threw/,
    );
    const second = await resolveBlocks(blocks, exchange, t.ctx);
    expect(second.systemAppend).toContain("ok");
    // Resolver ran twice: once failed, once succeeded. If the cache
    // poisoned the entry on rejection, the second call would have
    // returned the cached failure without re-invoking and calls would
    // still be 1.
    expect(calls).toBe(2);
  });

  /**
   * @case Cache key is BlockBody identity, not block name
   * @preconditions Two agents in the same context declare a block named "memory" with different BlockBody references; both lifetime: "context"
   * @expectedResult Each body resolves independently; one returning a fresh value does not poison the other's cache
   */
  test('lifetime "context" cache key is BlockBody identity, not name', async () => {
    const sink = spy();
    let aCalls = 0;
    let bCalls = 0;
    const bodyA: BlockBody = {
      mode: "inject",
      lifetime: "context",
      value: () => {
        aCalls += 1;
        return "A";
      },
    };
    const bodyB: BlockBody = {
      mode: "inject",
      lifetime: "context",
      value: () => {
        bCalls += 1;
        return "B";
      },
    };
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes([
        craft()
          .id("identity-a")
          .from(simple("a"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: { memory: bodyA },
            }),
          )
          .to(sink),
        craft()
          .id("identity-b")
          .from(simple("b"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: { memory: bodyB },
            }),
          )
          .to(sink),
      ])
      .build();
    await t.test();
    // Each body's resolver fired exactly once; they did not share a
    // cache entry under the shared "memory" name.
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });
});
