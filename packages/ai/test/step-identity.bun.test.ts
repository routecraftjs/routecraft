import { describe, expect, test } from "bun:test";
import { craft, direct, type Adapter, type Step } from "@routecraft/routecraft";
import { describeIdentity } from "@routecraft/testing";
import { agent, fromFile, tools, type AgentOptions } from "../src/index.ts";

const MODEL = "anthropic:claude-fable-5-2";

/** The steps of a route that enriches with one agent. */
function withAgent(
  options: AgentOptions & { stream?: false },
): Step<Adapter>[] {
  return craft()
    .id("identity")
    .from(direct())
    .enrich(agent(options))
    .build()[0]!.steps;
}

describe("step identity of the ai helpers", () => {
  /**
   * @case The tools an agent may call change
   * @preconditions Two agents that differ only in the names passed to `tools()`, and one that repeats the first
   * @expectedResult The digests differ for different names and match for equal ones, nothing is inferred, and the helper's own source is not in the digest's reach
   */
  test("tools() is identified by its items", () => {
    const steps = (names: string[]) =>
      withAgent({ model: MODEL, system: "s", tools: tools(names) });
    const a = describeIdentity(steps(["read"]));
    expect(a.inferred).toEqual([]);
    expect(a.digest).not.toBe(describeIdentity(steps(["read", "pay"])).digest);
    expect(a.digest).toBe(describeIdentity(steps(["read"])).digest);
  });

  /**
   * @case A tools builder and a guarded tool
   * @preconditions `tools()` given a builder callback, and given an item with a `guard`, each in two variants
   * @expectedResult The user's own callback and guard are part of the identity: editing either moves the digest
   */
  test("tools() covers a builder and a guard", () => {
    const built = [
      withAgent({ model: MODEL, system: "s", tools: tools(() => ["a"]) }),
      withAgent({ model: MODEL, system: "s", tools: tools(() => ["b"]) }),
    ].map((steps) => describeIdentity(steps));
    expect(built[0]!.digest).not.toBe(built[1]!.digest);
    expect(built[0]!.inferred).toEqual([]);

    const guarded = (guard: () => void) =>
      describeIdentity(
        withAgent({
          model: MODEL,
          system: "s",
          tools: tools([{ name: "pay", guard }]),
        }),
      );
    expect(
      guarded(() => {
        throw new Error("never");
      }).digest,
    ).not.toBe(guarded(() => undefined).digest);
  });

  /**
   * @case A prompt read from a file
   * @preconditions `fromFile()` with two paths, and the same path twice
   * @expectedResult The path is the identity: a different path moves the digest, the same path keeps it, and nothing is inferred. The file's contents are not read for it.
   */
  test("fromFile() is identified by its path", () => {
    const steps = (path: string) =>
      describeIdentity(
        withAgent({
          model: MODEL,
          system: "s",
          blocks: { identity: { mode: "inject", value: fromFile(path) } },
        }),
      );
    expect(steps("./a.md").inferred).toEqual([]);
    expect(steps("./a.md").digest).not.toBe(steps("./b.md").digest);
    expect(steps("./a.md").digest).toBe(steps("./a.md").digest);
  });

  /**
   * @case An agent bound by name
   * @preconditions `agent("reviewer")` and `agent("auditor")`
   * @expectedResult The name is the identity. What the registered agent is configured with is outside the digest, as a `direct()` target is.
   */
  test("a named agent is identified by its name", () => {
    const steps = (name: string) =>
      describeIdentity(
        craft().id("identity").from(direct()).enrich(agent(name)).build()[0]!
          .steps,
      );
    expect(steps("reviewer").inferred).toEqual([]);
    expect(steps("reviewer").digest).not.toBe(steps("auditor").digest);
  });
});
