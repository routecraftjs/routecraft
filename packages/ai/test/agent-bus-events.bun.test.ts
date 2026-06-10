import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { z } from "zod";
import {
  agent,
  agentPlugin,
  currentTime,
  randomUuid,
  llmPlugin,
  tools,
  type AgentDelta,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so the test stays hermetic. The mock
// invokes one of the registered tools so we can assert on the
// agent:tool:* events emitted by tool-bridge, then returns a
// consolidated result so agent:finished can fire.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(
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
        finishReason: "stop",
      };
    },
  ),
  streamLlm: mock(
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
        finishReason: "stop",
      };
    },
  ),
}));

describe("agent context-bus events", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    mock.clearAllMocks();
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
          agentPlugin({
            functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
          }),
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
              tools: tools(["CurrentTime"]),
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
    expect(invoked["toolName"]).toBe("CurrentTime");
    expect(invoked["toolCallId"]).toBe("call-CurrentTime-1");
    // Tool input/output ride in the `_snapshot` envelope so the
    // telemetry layer can drop them when snapshot capture is off.
    expect(invoked["_snapshot"]).toBeDefined();
    expect(invoked["_snapshot"] as Record<string, unknown>).toHaveProperty(
      "input",
    );
    const result = events[1]!.details as Record<string, unknown>;
    expect(result["toolName"]).toBe("CurrentTime");
    expect(result["duration"]).toBeTypeOf("number");
    expect(result["_snapshot"] as Record<string, unknown>).toHaveProperty(
      "output",
    );
  });

  /**
   * @case agent:tool:error fires when a tool handler throws
   * @preconditions Agent with one tool whose handler throws; mocked SDK drives a call
   * @expectedResult Subscriber receives invoked + error events with the thrown
   *   error inside `_snapshot` (errorName at top level, no top-level `error`
   *   field that would bypass the telemetry snapshot gate); result NOT emitted
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
    let errorDetails: Record<string, unknown> | undefined;
    t.ctx.on("route:with-throwing-tool:agent:tool:invoked" as never, () => {
      events.push("invoked");
    });
    t.ctx.on("route:with-throwing-tool:agent:tool:result" as never, () => {
      events.push("result");
    });
    t.ctx.on(
      "route:with-throwing-tool:agent:tool:error" as never,
      ({ details }: { details: unknown }) => {
        events.push("error");
        errorDetails = details as Record<string, unknown>;
      },
    );

    await t.test();

    expect(events).toEqual(["invoked", "error"]);
    // The thrown error may echo tool input, so the full object rides in
    // `_snapshot` (dropped from persisted telemetry unless captureSnapshots
    // is on); only the non-sensitive class name is a top-level field.
    expect(errorDetails!["errorName"]).toBe("Error");
    expect(errorDetails!["error"]).toBeUndefined();
    const snap = errorDetails!["_snapshot"] as Record<string, unknown>;
    expect(snap).toBeDefined();
    expect((snap["error"] as Error).message).toBe("tool-boom");
  });

  /**
   * @case agent:error fires when dispatch preparation fails
   * @preconditions Agent whose output spec passes upfront option checks
   *   (callable ~standard.validate) but cannot be converted to an AI SDK
   *   schema, so prepare() throws before any model call
   * @expectedResult started is followed by error; the run is not left
   *   orphaned in the running state with neither finished nor error
   */
  test("agent:error emitted when prepare fails", async () => {
    // Passes "is a Standard Schema with callable validate" but has no
    // convertible JSON schema, so toAiOutputSpec throws inside prepare.
    const bogusOutput = {
      "~standard": {
        version: 1,
        vendor: "bogus",
        validate: () => ({ value: null }),
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
          .id("prep-fail")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              output: bogusOutput as never,
            }),
          ),
      )
      .build();

    const events: string[] = [];
    t.ctx.on("route:prep-fail:agent:started" as never, () => {
      events.push("started");
    });
    t.ctx.on("route:prep-fail:agent:finished" as never, () => {
      events.push("finished");
    });
    t.ctx.on("route:prep-fail:agent:error" as never, () => {
      events.push("error");
    });

    await t.test().catch(() => undefined);

    expect(events).toEqual(["started", "error"]);
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
    expect(d["model"]).toBe("anthropic:claude-opus-4-7");
    expect(d["finishReason"]).toBe("stop");
    expect(d["inputTokens"]).toBe(10);
    expect(d["outputTokens"]).toBe(5);
    expect(d["totalTokens"]).toBe(15);
  });

  /**
   * @case agent:started fires at dispatch start with model + tool names
   * @preconditions Inline agent with one tool; mocked callLlm
   * @expectedResult Subscriber receives one started event carrying the
   *   resolved model, tool names, and turn budget
   */
  test("agent:started emitted with model, toolNames and maxTurns", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { CurrentTime: currentTime() } }),
        ],
      })
      .routes(
        craft()
          .id("started-agent")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              maxTurns: 7,
              tools: tools(["CurrentTime"]),
            }),
          ),
      )
      .build();

    const started: unknown[] = [];
    t.ctx.on(
      "route:started-agent:agent:started" as never,
      ({ details }: { details: unknown }) => {
        started.push(details);
      },
    );

    await t.test();

    expect(started).toHaveLength(1);
    const d = started[0] as Record<string, unknown>;
    expect(d["routeId"]).toBe("started-agent");
    expect(d["model"]).toBe("anthropic:claude-opus-4-7");
    expect(d["toolNames"]).toEqual(["CurrentTime"]);
    expect(d["maxTurns"]).toBe(7);
  });

  /**
   * @case Registered agents and fns announce themselves on context:started
   * @preconditions agentPlugin with one registered agent and one fn
   * @expectedResult agent:registered and agent:tool:registered fire once
   *   the context starts, carrying ids, description and source
   */
  test("agent:registered + agent:tool:registered emitted on context start", async () => {
    const registrations: Array<{ name: string; details: unknown }> = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              summariser: {
                description: "Summarises documents",
                model: "anthropic:claude-opus-4-7",
                system: "Be concise.",
              },
            },
            functions: { CurrentTime: currentTime() },
          }),
        ],
      })
      .routes(
        craft()
          .id("noop")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" })),
      )
      .build();

    t.ctx.on(
      "agent:registered" as never,
      ({ details }: { details: unknown }) => {
        registrations.push({ name: "agent", details });
      },
    );
    t.ctx.on(
      "agent:tool:registered" as never,
      ({ details }: { details: unknown }) => {
        registrations.push({ name: "tool", details });
      },
    );

    await t.test();

    const agentReg = registrations.find((r) => r.name === "agent")?.details as
      | Record<string, unknown>
      | undefined;
    expect(agentReg).toBeDefined();
    expect(agentReg!["agentId"]).toBe("summariser");
    expect(agentReg!["model"]).toBe("anthropic:claude-opus-4-7");
    expect(agentReg!["source"]).toBe("registered");

    const toolReg = registrations.find((r) => r.name === "tool")?.details as
      | Record<string, unknown>
      | undefined;
    expect(toolReg).toBeDefined();
    expect(toolReg!["toolName"]).toBe("CurrentTime");
    expect(toolReg!["source"]).toBe("registered");
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
