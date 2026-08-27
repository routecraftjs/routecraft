import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  craft,
  http,
  noop,
  only,
  simple,
  type CraftConfig,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  llmPlugin,
  type AgentDelta,
  type AgentStream,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

/**
 * `agent({ stream: true })`: the dispatch produces the deltas instead of
 * the consolidated result, so a route can stream a model's answer without
 * hand-rolling a queue in a `.transform()` step.
 *
 * The mocked provider emits its tokens slowly and reports whether the run
 * was aborted, which is what makes the two interesting cases observable: a
 * consumer that reads every delta, and one that walks away mid-answer.
 */

const TOKENS = ["Hel", "lo ", "world"];

/** Set by the mock so a test can assert the run was cancelled, not drained. */
let aborted = false;

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => ({
    text: "non-stream",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })),
  streamLlm: mock(
    async ({
      onDelta,
      abortSignal,
    }: {
      onDelta: (d: AgentDelta) => void | Promise<void>;
      abortSignal?: AbortSignal;
    }): Promise<LlmResult> => {
      for (const text of TOKENS) {
        if (abortSignal?.aborted === true) {
          aborted = true;
          throw new Error("aborted");
        }
        await onDelta({ type: "text-delta", text });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        text: TOKENS.join(""),
        usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
      };
    },
  ),
}));

describe("agent({ stream: true })", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    aborted = false;
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Streaming and pushing deltas are the same thing spelled twice
   * @preconditions Agent options carry both `stream: true` and an `onDelta` listener
   * @expectedResult Construction is refused with RC5003 rather than one silently winning
   */
  test("refuses stream and onDelta together", () => {
    expect(() =>
      agent({
        model: "anthropic:claude-opus-4-7",
        system: "x",
        stream: true,
        onDelta: () => {},
      }),
    ).toThrow(/cannot both be set/);
  });

  /**
   * @case The dispatch puts the delta stream on the exchange
   * @preconditions Route ends in agent({ stream: true }); a process step drains the body
   * @expectedResult Every token arrives in order, and the consolidated result never appears
   */
  test("puts an iterable of deltas on the exchange", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-body")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              stream: true,
            }),
          )
          .process(async (ex) => {
            for await (const delta of ex.body as AgentStream) {
              seen.push(delta.text);
            }
            return ex;
          })
          .to(noop()),
      )
      .build();

    await t.test();
    expect(seen).toEqual(TOKENS);
    expect(aborted).toBe(false);
  });

  /**
   * @case Abandoning the stream stops the model
   * @preconditions Consumer breaks out of the for-await after the first delta
   * @expectedResult The provider sees an aborted signal instead of writing the rest
   */
  test("abandoning the stream aborts the run", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-abandon")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              stream: true,
            }),
          )
          .process(async (ex) => {
            for await (const delta of ex.body as AgentStream) {
              seen.push(delta.text);
              break;
            }
            return ex;
          })
          .to(noop()),
      )
      .build();

    await t.test();
    expect(seen).toEqual([TOKENS[0]!]);
    // The run unwinds on its own timeline; the abort is what it acts on.
    const deadline = Date.now() + 1000;
    while (!aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(aborted).toBe(true);
  });

  /**
   * @case The stream survives an aggregator that merges rather than replaces
   * @preconditions .enrich(agent({ stream: true }), agg) folds the stream into a field
   * @expectedResult The aggregated body carries the same live stream, drainable downstream
   */
  test("works under .enrich() with an aggregator", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-enrich")
          .from(simple({ topic: "greetings" }))
          .enrich(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              stream: true,
            }),
            only((reply: AgentStream) => reply, "reply"),
          )
          .process(async (ex) => {
            const merged = ex.body as { topic: string; reply: AgentStream };
            expect(merged.topic).toBe("greetings");
            for await (const delta of merged.reply) seen.push(delta.text);
            return ex;
          })
          .to(noop()),
      )
      .build();

    await t.test();
    expect(seen).toEqual(TOKENS);
  });

  /**
   * @case The stream reaches the wire as SSE without a mapping step
   * @preconditions A route from http() ending in agent({ stream: true })
   * @expectedResult text/event-stream carrying one JSON frame per delta
   */
  test("streams as SSE straight from an http route", async () => {
    let port = 0;
    t = await testContext()
      .on("server:listening", ({ details }) => {
        port = details.port;
      })
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        http: {},
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      } as CraftConfig)
      .routes(
        craft()
          .id("chat-stream")
          .from(http({ path: "/chat/stream", method: "POST" }))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              user: () => "hi",
              stream: true,
            }),
          ),
      )
      .build();
    await t.startAndWaitReady();
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );

    const body = await res.text();
    for (const token of TOKENS) {
      expect(body).toContain(
        `data: ${JSON.stringify({ type: "text-delta", text: token })}`,
      );
    }
  });
});
