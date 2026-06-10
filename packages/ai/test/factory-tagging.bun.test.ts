import { describe, expect, test } from "bun:test";
import { agent, embedding, llm, mcp } from "../src/index.ts";

// getAdapterFactory / getAdapterArgs are @internal to core and not part of
// the public package surface; the tag symbols are global (Symbol.for) by
// design so cross-package tests and duplicate package resolutions can read
// them. Resolve the symbols directly instead of widening the public API.
const FACTORY = Symbol.for("routecraft.adapter.factory");
const ARGS = Symbol.for("routecraft.adapter.args");

function factoryOf(instance: unknown): unknown {
  return (instance as Record<symbol, unknown>)[FACTORY];
}
function argsOf(instance: unknown): unknown {
  return (instance as Record<symbol, unknown>)[ARGS];
}

describe("ai adapter factory tagging conformance", () => {
  /**
   * @case llm() tags its instances with the llm factory
   * @preconditions Factory invoked with a model id and no options
   * @expectedResult The factory tag is llm and args is ["ollama:m"]
   */
  test("llm tags instances with the factory reference", () => {
    const instance = llm("ollama:m");
    expect(factoryOf(instance)).toBe(llm);
    expect(argsOf(instance)).toEqual(["ollama:m"]);
  });

  /**
   * @case embedding() tags its instances with the embedding factory
   * @preconditions Factory invoked with model id and using() option
   * @expectedResult The factory tag is embedding and args has both call args
   */
  test("embedding tags instances with the factory reference", () => {
    const using = (ex: { body: string }) => ex.body;
    const instance = embedding("huggingface:m", { using });
    expect(factoryOf(instance)).toBe(embedding);
    expect(argsOf(instance)).toEqual(["huggingface:m", { using }]);
  });

  /**
   * @case agent() tags its instances with the agent factory
   * @preconditions Factory invoked with a minimal options object
   * @expectedResult The factory tag is agent
   */
  test("agent tags instances with the factory reference", () => {
    const instance = agent({ model: "ollama:m", system: "You are a test." });
    expect(factoryOf(instance)).toBe(agent);
  });

  /**
   * @case mcp() tags its instances with the mcp factory
   * @preconditions Factory invoked with a tool endpoint string
   * @expectedResult The factory tag is mcp
   */
  test("mcp tags instances with the factory reference", () => {
    const instance = mcp("server:tool");
    expect(factoryOf(instance)).toBe(mcp);
  });
});
