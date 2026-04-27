import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { z } from "zod";
import {
  agent,
  agentPlugin,
  defaultFns,
  llmPlugin,
  tools,
  type AgentDelta,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so the test stays hermetic. The mock
// invokes one of the registered tools so we can assert on the
// agent:tool:* events emitted by tool-bridge, then returns a
// consolidated result so agent:finished can fire.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (params: {
      tools?: Record<
        string,
        { execute: (input: unknown, opts: unknown) => Promise<unknown> }
      >;
    }): Promise<LlmResult> => {
      // If the agent has tools, drive a single tool call so the
      // wrapper emits invoked + result.
      const toolMap = params.tools;
      if (toolMap) {
        const [name, t] = Object.entries(toolMap)[0]!;
        await t.execute(
          {},
          {
            toolCallId: `call-${name}-1`,
            abortSignal: new AbortController().signal,
          },
        );
      }
      return {
        text: "stubbed-response",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        raw: { finishReason: "stop" },
      };
    },
  ),
  streamLlm: vi.fn(
    async (params: {
      onDelta: (d: AgentDelta) => void | Promise<void>;
      tools?: Record<
        string,
        { execute: (input: unknown, opts: unknown) => Promise<unknown> }
      >;
    }): Promise<LlmResult> => {
      const toolMap = params.tools;
      if (toolMap) {
        const [name, t] = Object.entries(toolMap)[0]!;
        await t.execute(
          {},
          {
            toolCallId: `call-${name}-1`,
            abortSignal: new AbortController().signal,
          },
        );
      }
      await params.onDelta({ type: "text-delta", text: "ok" });
      return {
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        raw: { finishReason: "stop" },
      };
    },
  ),
}));

describe("agent context-bus events", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case agent:tool:invoked / result fire on the context bus when a tool is called
   * @preconditions Agent with one tool; mocked callLlm drives one tool call
   * @expectedResult Subscriber on route:*:agent:tool:* receives invoked + result events with stable fields
   */
  test("tool:invoked + tool:result emitted on context bus", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ...defaultFns } }),
        ],
      })
      .routes(
        craft()
          .id("with-tool")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["currentTime"]),
            }),
          ),
      )
      .build();

    const events: Array<{ name: string; details: unknown }> = [];
    t.ctx.on(
      "route:with-tool:agent:tool:invoked" as never,
      ({ details }: { details: unknown }) => {
        events.push({ name: "invoked", details });
      },
    );
    t.ctx.on(
      "route:with-tool:agent:tool:result" as never,
      ({ details }: { details: unknown }) => {
        events.push({ name: "result", details });
      },
    );

    await t.test();

    expect(events.map((e) => e.name)).toEqual(["invoked", "result"]);
    const invoked = events[0]!.details as Record<string, unknown>;
    expect(invoked["routeId"]).toBe("with-tool");
    expect(invoked["toolName"]).toBe("currentTime");
    expect(invoked["toolCallId"]).toBe("call-currentTime-1");
    const result = events[1]!.details as Record<string, unknown>;
    expect(result["toolName"]).toBe("currentTime");
    expect(result["duration"]).toBeTypeOf("number");
  });

  /**
   * @case agent:tool:error fires when a tool handler throws
   * @preconditions Agent with one tool whose handler throws; mocked SDK drives a call
   * @expectedResult Subscriber receives invoked + error events; result NOT emitted
   */
  test("tool:error emitted on context bus when handler throws", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            functions: {
              boomTool: {
                description: "Always throws",
                input: z.object({}),
                handler: async () => {
                  throw new Error("tool-boom");
                },
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("with-throwing-tool")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              tools: tools(["boomTool"]),
            }),
          ),
      )
      .build();

    const events: string[] = [];
    t.ctx.on("route:with-throwing-tool:agent:tool:invoked" as never, () => {
      events.push("invoked");
    });
    t.ctx.on("route:with-throwing-tool:agent:tool:result" as never, () => {
      events.push("result");
    });
    t.ctx.on("route:with-throwing-tool:agent:tool:error" as never, () => {
      events.push("error");
    });

    await t.test();

    expect(events).toEqual(["invoked", "error"]);
  });

  /**
   * @case agent:finished fires after the dispatch returns
   * @preconditions Agent without tools; happy-path LLM call
   * @expectedResult Subscriber receives one finished event with usage and finishReason
   */
  test("agent:finished emitted with usage and finishReason", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("simple-agent")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" })),
      )
      .build();

    const finished: unknown[] = [];
    t.ctx.on(
      "route:simple-agent:agent:finished" as never,
      ({ details }: { details: unknown }) => {
        finished.push(details);
      },
    );

    await t.test();

    expect(finished).toHaveLength(1);
    const d = finished[0] as Record<string, unknown>;
    expect(d["routeId"]).toBe("simple-agent");
    expect(d["finishReason"]).toBe("stop");
    expect(d["inputTokens"]).toBe(10);
    expect(d["outputTokens"]).toBe(5);
    expect(d["totalTokens"]).toBe(15);
  });

  /**
   * @case Per-call onDelta on agent("name", { onDelta }) is forwarded to the streaming path
   * @preconditions Registered agent + by-name dispatch with per-call onDelta override
   * @expectedResult Listener receives the mock's text-delta; streamLlm path was used
   */
  test("by-name agent accepts per-call onDelta override", async () => {
    const deltas: AgentDelta[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              namedAgent: {
                description: "Test named agent",
                model: "anthropic:claude-opus-4-7",
                system: "Be helpful.",
              },
            },
          }),
        ],
      })
      .routes(
        craft()
          .id("uses-named")
          .from(simple("hi"))
          .to(
            agent("namedAgent", {
              onDelta: (d) => {
                deltas.push(d);
              },
            }),
          ),
      )
      .build();

    await t.test();

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ type: "text-delta", text: "ok" });
  });
});
