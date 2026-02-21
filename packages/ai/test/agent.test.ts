import { describe, test, expect, afterEach, vi } from "vitest";
import { agent, AgentAdapter } from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

describe("agent() DSL and adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case agent(options) returns an AgentAdapter instance
   * @preconditions None
   * @expectedResult Destination has adapterId routecraft.adapter.agent
   */
  test("agent(options) returns an AgentAdapter", () => {
    const dest = agent({
      modelId: "ollama:llama3",
      systemPrompt: "You are helpful.",
    });
    expect(dest).toBeInstanceOf(AgentAdapter);
    expect(dest.adapterId).toBe("routecraft.adapter.agent");
  });

  /**
   * @case agent() with invalid modelId throws at construction
   * @preconditions modelId missing colon or invalid format
   * @expectedResult Error message mentions providerId:modelName
   */
  test("agent() throws when modelId format is invalid", () => {
    expect(() =>
      agent({ modelId: "nom colon" } as { modelId: string }),
    ).toThrow(/providerId:modelName/);
    expect(() => agent({ modelId: "" } as { modelId: string })).toThrow(
      /providerId:modelName/,
    );
    expect(() =>
      agent({ modelId: "onlyprefix:" } as { modelId: string }),
    ).toThrow(/providerId:modelName/);
    expect(() =>
      agent({ modelId: ":onlysuffix" } as { modelId: string }),
    ).toThrow(/providerId:modelName/);
  });

  /**
   * @case send() returns pass-through result (Phase 1)
   * @preconditions Route uses .to(agent({ modelId: "ollama:any" }))
   * @expectedResult Body replaced with AgentResult { output: originalBody, steps: 0 }
   */
  test("send() returns pass-through result", async () => {
    const destSpy = vi.fn();
    t = await testContext()
      .routes([
        craft()
          .id("agent-pass-through")
          .from(simple({ question: "What is 2+2?" }))
          .to(
            agent({
              modelId: "ollama:llama3",
              systemPrompt: "Answer concisely.",
              allowedRoutes: ["get-data"],
              allowedMcpServers: ["browser"],
              maxSteps: 5,
            }),
          )
          .to(destSpy),
      ])
      .with({ plugins: [] })
      .build();

    const warnSpy = vi
      .spyOn(globalThis.console, "warn")
      .mockImplementation(() => {});

    await t.test();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const result = destSpy.mock.calls[0][0].body as {
      output: unknown;
      steps?: number;
    };
    expect(result).toMatchObject({
      output: { question: "What is 2+2?" },
      steps: 0,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[agent] pass-through — implementation pending",
    );
    warnSpy.mockRestore();
  });
});
