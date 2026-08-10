import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  craft,
  direct,
  markAuthentic,
  simple,
  type Principal,
  type Source,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin } from "../src/index.ts";
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

describe("agent blocks: resolver client.forward()", () => {
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
   * @case A resolver forwards to a registered direct route via client.forward and its return lands in the system prompt
   * @preconditions Memory route registered with direct(); inject block whose value forwards to it
   * @expectedResult The captured system prompt carries the forwarded route's returned content
   */
  test("client.forward(routeId, payload) feeds the resolver", async () => {
    const sink = spy();
    const memorySink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes([
        craft()
          .id("memory-get")
          .from(direct())
          .transform((body: unknown) => {
            const data = body as { principal: string };
            return `Notes for ${data.principal}`;
          })
          .to(memorySink),
        craft()
          .id("chat")
          .from(simple("hi"))
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                memory: {
                  mode: "inject",
                  value: async (_exchange, _context, _events, client) => {
                    const result = await client.forward("memory-get", {
                      principal: "jane",
                    });
                    return result as string;
                  },
                },
              },
            }),
          )
          .to(sink),
      ])
      .build();

    await t.test();
    expect(memorySink.received.length).toBeGreaterThan(0);
    expect(capturedSystem).toContain("## memory");
    expect(capturedSystem).toContain("Notes for jane");
  });

  /**
   * @case client.forward() carries the dispatching exchange's principal into the resolved route
   * @preconditions Calling route runs under an authentic principal; the memory route declares .authorize()
   * @expectedResult The memory route completes under the caller's identity and its content reaches the system prompt
   */
  test("client.forward() reaches a guarded route as the caller", async () => {
    const sink = spy();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "jane",
      scopes: ["kb:read"],
    };
    const principalSource: Source<string> = {
      subscribe: async (sub) => {
        await sub.emit({
          message: "hi",
          headers: { "routecraft.auth.principal": markAuthentic(principal) },
        });
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
          .id("guarded-memory")
          .authorize({ scopes: ["kb:read"] })
          .from(direct())
          .transform(
            (_body: unknown, ex) => `Notes for ${ex.principal?.subject}`,
          ),
        craft()
          .id("guarded-chat")
          .from(principalSource)
          .to(
            agent({
              system: "Base.",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                memory: {
                  mode: "inject",
                  value: async (_exchange, _context, _events, client) =>
                    (await client.forward("guarded-memory", {})) as string,
                },
              },
            }),
          )
          .to(sink),
      ])
      .build();

    await t.test();
    expect(capturedSystem).toContain("Notes for jane");
  });
});
