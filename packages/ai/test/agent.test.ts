import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple, type Exchange } from "@routecraft/routecraft";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  agent,
  AgentDestinationAdapter,
  agentPlugin,
  defineAgent,
  llmPlugin,
  type AgentResult,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so tests do not hit any provider network. Each
// happy-path test asserts on the call args and controls the response shape.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (): Promise<LlmResult> => ({
      text: "stubbed-response",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  ),
}));

import { callLlm } from "../src/llm/providers/index.ts";
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

describe("agent() destination", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case agent({...}) returns an AgentDestinationAdapter with the expected adapterId
   * @preconditions Valid options
   * @expectedResult Returned destination is an AgentDestinationAdapter instance with adapterId "routecraft.adapter.agent"
   */
  test("returns AgentDestinationAdapter with stable adapterId", () => {
    const dest = agent({
      model: "anthropic:claude-opus-4-7",
      system: "You answer concisely.",
    });
    expect(dest).toBeInstanceOf(AgentDestinationAdapter);
    expect(dest.adapterId).toBe("routecraft.adapter.agent");
  });

  /**
   * @case agent() throws when system prompt is missing or blank
   * @preconditions Options without system, or with whitespace system
   * @expectedResult Construction throws and the message mentions "system"
   */
  test("throws when system is missing or blank", () => {
    expect(() =>
      agent({
        model: "anthropic:claude-opus-4-7",
      } as unknown as Parameters<typeof agent>[0]),
    ).toThrow(/system/i);
    expect(() =>
      agent({
        model: "anthropic:claude-opus-4-7",
        system: "   ",
      }),
    ).toThrow(/system/i);
  });

  /**
   * @case agent() throws when the model string is malformed
   * @preconditions Model string without a colon, or with empty halves
   * @expectedResult Construction throws and the message mentions "providerId:modelName"
   */
  test("throws on malformed model string", () => {
    const base = { system: "y" };
    expect(() => agent({ ...base, model: "no-colon-here" })).toThrow(
      /providerId:modelName/,
    );
    expect(() => agent({ ...base, model: "trailing-colon:" })).toThrow(
      /providerId:modelName/,
    );
    expect(() => agent({ ...base, model: ":no-prefix" })).toThrow(
      /providerId:modelName/,
    );
  });

  /**
   * @case agent() accepts an inline LlmModelConfig object as model
   * @preconditions model passed as { provider, apiKey } object
   * @expectedResult Construction succeeds without llmPlugin in the context
   */
  test("accepts an inline LlmModelConfig", () => {
    const dest = agent({
      model: { provider: "anthropic", apiKey: "sk-test" },
      system: "ok",
    });
    expect(dest).toBeInstanceOf(AgentDestinationAdapter);
  });

  /**
   * @case end-to-end: route with agent calls callLlm with system + body-derived user prompt
   * @preconditions Route from simple body, .to(agent({...})), .to(spy)
   * @expectedResult callLlm is called once with the configured system and the body as user prompt; downstream body is AgentResult
   */
  test("end-to-end: dispatches callLlm and replaces body with AgentResult", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("e2e-agent")
          .description("Echoes input via a stubbed agent")
          .from(simple("hello world"))
          .to(
            agent({
              model: "anthropic:claude-opus-4-7",
              system: "Be helpful.",
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();

    expect(callLlmMock).toHaveBeenCalledTimes(1);
    const args = callLlmMock.mock.calls[0][0];
    expect(args.systemPrompt).toBe("Be helpful.");
    expect(args.userPrompt).toBe("hello world");
    expect(args.modelId).toBe("claude-opus-4-7");

    expect(sink.received).toHaveLength(1);
    const body = sink.received[0].body as AgentResult;
    expect(body.text).toBe("stubbed-response");
    expect(body.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  /**
   * @case body objects are JSON-stringified into the user prompt by default
   * @preconditions Route from simple({ q: "..." }), .to(agent({...}))
   * @expectedResult callLlm receives the JSON form of the body as user prompt
   */
  test("default user prompt JSON-stringifies object bodies", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("json-body")
          .from(simple({ q: "what?" }))
          .to(
            agent({
              model: "anthropic:claude-opus-4-7",
              system: "s",
            }),
          ),
      )
      .build();

    await t.test();

    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(callLlmMock.mock.calls[0][0].userPrompt).toBe('{"q":"what?"}');
  });

  /**
   * @case custom user override is invoked instead of the default body derivation
   * @preconditions agent({ ..., user: (ex) => "custom prompt" })
   * @expectedResult callLlm receives the value returned by the user function
   */
  test("custom user override is honoured", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("user-override")
          .from(simple({ name: "alice" }))
          .to(
            agent({
              model: "anthropic:claude-opus-4-7",
              system: "s",
              user: (ex: Exchange<unknown>) =>
                `Greet ${(ex.body as { name: string }).name}`,
            }),
          ),
      )
      .build();

    await t.test();

    expect(callLlmMock.mock.calls[0][0].userPrompt).toBe("Greet alice");
  });
});

describe("agent(name) by-name destination + agentPlugin / defineAgent", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case defineAgent throws when id is missing or blank
   * @preconditions Registration options with no id
   * @expectedResult defineAgent throws with a message mentioning "id"
   */
  test("defineAgent throws when id is missing or blank", () => {
    expect(() =>
      defineAgent({
        description: "x",
        model: "anthropic:claude-opus-4-7",
        system: "y",
      } as unknown as Parameters<typeof defineAgent>[0]),
    ).toThrow(/id/i);
    expect(() =>
      defineAgent({
        id: "  ",
        description: "x",
        model: "anthropic:claude-opus-4-7",
        system: "y",
      }),
    ).toThrow(/id/i);
  });

  /**
   * @case defineAgent throws when description is missing or blank
   * @preconditions Registration options with no description
   * @expectedResult defineAgent throws with a message mentioning "description"
   */
  test("defineAgent throws when description is missing or blank", () => {
    expect(() =>
      defineAgent({
        id: "x",
        model: "anthropic:claude-opus-4-7",
        system: "y",
      } as unknown as Parameters<typeof defineAgent>[0]),
    ).toThrow(/description/i);
    expect(() =>
      defineAgent({
        id: "x",
        description: "   ",
        model: "anthropic:claude-opus-4-7",
        system: "y",
      }),
    ).toThrow(/description/i);
  });

  /**
   * @case agentPlugin throws on duplicate agent ids at context init
   * @preconditions Two registrations sharing the same id
   * @expectedResult build() rejects with a message identifying the duplicate id
   */
  test("agentPlugin throws on duplicate id at context init", async () => {
    const a = defineAgent({
      id: "dup",
      description: "first",
      model: "anthropic:claude-opus-4-7",
      system: "s",
    });
    const b = defineAgent({
      id: "dup",
      description: "second",
      model: "anthropic:claude-opus-4-7",
      system: "s",
    });
    await expect(
      testContext()
        .with({ plugins: [agentPlugin({ agents: [a, b] })] })
        .routes(craft().id("noop").from(simple("x")))
        .build(),
    ).rejects.toThrow(/dup/);
  });

  /**
   * @case agentPlugin rejects entries not produced by defineAgent
   * @preconditions Plain object passed where AgentRegistration is expected
   * @expectedResult build() rejects with a message pointing to defineAgent
   */
  test("agentPlugin rejects raw config objects", async () => {
    const raw = {
      id: "summariser",
      description: "x",
      model: "anthropic:claude-opus-4-7",
      system: "s",
    } as unknown as Parameters<typeof agentPlugin>[0];
    await expect(
      testContext()
        .with({
          plugins: [
            agentPlugin({
              agents: [raw] as unknown as Parameters<
                typeof agentPlugin
              >[0]["agents"],
            }),
          ],
        })
        .routes(craft().id("noop").from(simple("x")))
        .build(),
    ).rejects.toThrow(/defineAgent/);
  });

  /**
   * @case agent(name) without any registered agents throws RC5004 at dispatch
   * @preconditions Route uses .to(agent("missing")), no agentPlugin installed
   * @expectedResult Sink is never reached; the framework emits context:error with rc === "RC5004"
   */
  test("agent(name) without registry throws RC5004 at dispatch", async () => {
    const sink = spy();
    const errors: Array<{ rc?: string; message?: string }> = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .on("context:error", (event) => {
        const { error } = (event as { details: { error: unknown } }).details;
        errors.push(error as { rc?: string; message?: string });
      })
      .routes(
        craft()
          .id("missing-registry")
          .from(simple("hi"))
          .to(agent("missing"))
          .to(sink),
      )
      .build();

    await t.test();
    expect(sink.received).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].rc).toBe("RC5004");
    expect(String(errors[0].message)).toMatch(/missing/);
  });

  /**
   * @case agent(name) resolves a registered agent and dispatches its system prompt
   * @preconditions agentPlugin registers "summariser"; route .to(agent("summariser"))
   * @expectedResult callLlm is called with the registered system prompt and the body as user prompt
   */
  test("agent(name) resolves a registered agent and dispatches it", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: [
              defineAgent({
                id: "summariser",
                description: "Summarises text",
                model: "anthropic:claude-opus-4-7",
                system: "Summarise the input.",
              }),
            ],
          }),
        ],
      })
      .routes(
        craft()
          .id("by-name")
          .from(simple("a long document"))
          .to(agent("summariser"))
          .to(sink),
      )
      .build();

    await t.test();

    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(callLlmMock.mock.calls[0][0].systemPrompt).toBe(
      "Summarise the input.",
    );
    expect(callLlmMock.mock.calls[0][0].userPrompt).toBe("a long document");
    expect(sink.received).toHaveLength(1);
    expect((sink.received[0].body as AgentResult).text).toBe(
      "stubbed-response",
    );
  });
});
