import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, currentTime, randomUuid, tools } from "../src/index.ts";
import { isToolSelection } from "../src/agent/tools/selection.ts";

async function buildCtx(opts: {
  functions?: NonNullable<Parameters<typeof agentPlugin>[0]>["functions"];
}): Promise<TestContext> {
  return await testContext()
    .with({
      plugins: [agentPlugin({ functions: opts.functions ?? {} })],
    })
    .build();
}

describe("tools() resolver - shape", () => {
  /**
   * @case tools(items) returns a branded selection descriptor
   * @preconditions tools(["CurrentTime"])
   * @expectedResult isToolSelection returns true; resolve is callable
   */
  test("tools() returns a branded selection descriptor", () => {
    const sel = tools(["CurrentTime"]);
    expect(isToolSelection(sel)).toBe(true);
    expect(typeof sel.resolve).toBe("function");
  });

  /**
   * @case tools(items) rejects non-array input
   * @preconditions tools("CurrentTime" as never)
   * @expectedResult RC5003 thrown synchronously
   */
  test("tools() rejects non-array input", () => {
    expect(() => tools("CurrentTime" as never)).toThrow(/array/i);
  });
});

describe("tools() resolver - bare references", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Bare fn name resolves against the fn registry
   * @preconditions agentPlugin functions includes CurrentTime; resolve tools(["CurrentTime"])
   * @expectedResult Single ResolvedTool named "CurrentTime" with description and handler from currentTime()
   */
  test("bare fn name resolves to a registered fn", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const resolved = tools(["CurrentTime"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("CurrentTime");
    expect(resolved[0].description).toMatch(/timestamp/i);
    expect(typeof resolved[0].handler).toBe("function");
    expect(resolved[0].tags).toContain("read-only");
  });

  /**
   * @case Direct(routeId) ref resolves via the direct registry
   * @preconditions Direct route "fetch-order" registered with description + input
   * @expectedResult Single ResolvedTool whose LLM-facing name is "direct_fetch-order"
   */
  test("Direct(routeId) ref resolves via the direct registry", async () => {
    const inputSchema = z.object({ orderId: z.string() });
    t = await testContext()
      .routes([
        craft()
          .id("fetch-order")
          .description("Fetch an order by id.")
          .input(inputSchema)
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const resolved = tools(["Direct(fetch-order)"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("direct_fetch-order");
    expect(resolved[0].description).toBe("Fetch an order by id.");
    expect(resolved[0].input).toBe(inputSchema);
  });

  /**
   * @case A bare "direct_x" is a plain fn id; the route form is "Direct(x)"
   * @preconditions Route "x" registered AND a fn registry entry literally named "direct_x"
   * @expectedResult tools(["direct_x"]) resolves the fn; tools(["Direct(x)"]) resolves the route
   */
  test("bare direct_ name is a plain fn id; Direct(id) is the route", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              direct_x: {
                description: "Explicit fn registry entry.",
                input: z.object({}),
                handler: () => "explicit",
                tags: ["read-only"],
              },
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("x")
          .description("Route description.")
          .input(z.object({}))
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const [asFn] = tools(["direct_x"]).resolve(t.ctx);
    expect(asFn.description).toBe("Explicit fn registry entry.");

    const [asRoute] = tools(["Direct(x)"]).resolve(t.ctx);
    expect(asRoute.name).toBe("direct_x");
    expect(asRoute.description).toBe("Route description.");
  });

  /**
   * @case Unknown bare name throws RC5003
   * @preconditions agentPlugin without "missing"; resolve tools(["missing"])
   * @expectedResult RC5003 thrown listing available names
   */
  test("unknown bare name throws RC5003", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    let caught: unknown;
    try {
      tools(["missing"]).resolve(t.ctx);
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5003");
    expect((caught as Error).message).toMatch(/missing/);
    expect((caught as Error).message).toMatch(/CurrentTime|RandomUuid/);
  });

  /**
   * @case Agent(...) references are not supported and surface as unknown tools
   * @preconditions resolve tools(["Agent(researcher)"]) with no such fn registered
   * @expectedResult RC5003 unknown-tool error (sub-agent tools are not implemented)
   */
  test("Agent(...) ref throws unknown-tool", async () => {
    t = await buildCtx({});
    expect(() => tools(["Agent(researcher)"]).resolve(t!.ctx)).toThrow(
      /unknown tool/i,
    );
  });
});

describe("tools() resolver - { name, guard }", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case { name, guard } attaches the guard to the resolved tool
   * @preconditions tools([{ name: "CurrentTime", guard: g }]) with CurrentTime registered
   * @expectedResult ResolvedTool.guard is the supplied function
   */
  test("{ name, guard } attaches the guard", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const guard = mock();
    const [resolved] = tools([{ name: "CurrentTime", guard }]).resolve(t.ctx);
    expect(resolved.name).toBe("CurrentTime");
    expect(resolved.guard).toBe(guard);
  });

  /**
   * @case { name } with empty/blank string throws
   * @preconditions tools([{ name: "" }])
   * @expectedResult RC5003 thrown synchronously at resolve
   */
  test("{ name } rejects empty string", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    expect(() => tools([{ name: "" }]).resolve(t!.ctx)).toThrow(/non-empty/i);
  });

  /**
   * @case { name, description } overrides description for THIS binding
   * @preconditions tools([{ name: "CurrentTime", description: "Per-agent framing" }]) with CurrentTime registered
   * @expectedResult ResolvedTool.description is the override; the registry entry's description is unchanged
   */
  test("{ name, description } overrides description per binding", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const [resolved] = tools([
      {
        name: "CurrentTime",
        description: "Per-agent framing of the time tool.",
      },
    ]).resolve(t.ctx);
    expect(resolved.description).toBe("Per-agent framing of the time tool.");

    // Registry entry stays canonical: a second binding without the
    // override sees the original description.
    const [resolved2] = tools(["CurrentTime"]).resolve(t.ctx);
    expect(resolved2.description).toBe(currentTime().description);
    expect(resolved2.description).not.toBe(resolved.description);
  });

  /**
   * @case { name, description } rejects empty/blank string
   * @preconditions tools([{ name: "CurrentTime", description: "" }])
   * @expectedResult RC5003 with a message naming the field
   */
  test("{ name, description } rejects empty string", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    expect(() =>
      tools([{ name: "CurrentTime", description: "" }]).resolve(t!.ctx),
    ).toThrow(/description.*non-empty/i);
  });

  /**
   * @case { name, description } combines with guard override
   * @preconditions Both description and guard set in the same item
   * @expectedResult Resolved tool has both the override description and the guard
   */
  test("{ name, guard, description } applies both overrides", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const guard = mock();
    const [resolved] = tools([
      {
        name: "CurrentTime",
        guard,
        description: "Reframed for this agent.",
      },
    ]).resolve(t.ctx);
    expect(resolved.guard).toBe(guard);
    expect(resolved.description).toBe("Reframed for this agent.");
  });
});

describe("tools() resolver - misc", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Same tool referenced twice surfaces only once (later ref wins)
   * @preconditions tools(["CurrentTime", "CurrentTime"])
   * @expectedResult Single ResolvedTool
   */
  test("duplicate explicit refs are deduplicated", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const resolved = tools(["CurrentTime", "CurrentTime"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
  });

  /**
   * @case Object item missing the "name" field is rejected
   * @preconditions tools([{ guard: () => {} } as never])
   * @expectedResult RC5003 thrown when resolve() runs, prompting the author to use a name
   */
  test("tools() throws on object items lacking name", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime() },
    });
    expect(() =>
      tools([{ guard: () => undefined } as never]).resolve(t!.ctx),
    ).toThrow(/string or \{ name/);
  });
});

describe("tools() resolver - builder form", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Builder receives a catalog and returns the same shape the array form accepts
   * @preconditions Two fns registered; builder filters by tag
   * @expectedResult The filtered fns end up in the resolved list
   */
  test("builder can filter fns by tag from the catalog", async () => {
    t = await buildCtx({
      functions: {
        CurrentTime: currentTime(),
        RandomUuid: randomUuid(),
        wipe: {
          description: "Wipe data.",
          input: z.object({}),
          handler: () => "ok",
          tags: ["destructive"],
        },
      },
    });
    const resolved = tools((catalog) =>
      catalog.fns
        .filter((f) => f.tags?.includes("read-only"))
        .map((f) => f.name),
    ).resolve(t.ctx);
    expect(resolved.map((r) => r.name).sort()).toEqual([
      "CurrentTime",
      "RandomUuid",
    ]);
  });

  /**
   * @case Builder can mix explicit refs with predicate-derived names
   * @preconditions Three fns; builder lists one explicitly and predicate-derives the rest
   * @expectedResult All explicit and matched fns surface; the union is deduplicated
   */
  test("builder mixes explicit refs with catalog-derived names", async () => {
    t = await buildCtx({
      functions: {
        CurrentTime: currentTime(),
        RandomUuid: randomUuid(),
        wipe: {
          description: "Wipe data.",
          input: z.object({}),
          handler: () => "ok",
          tags: ["destructive"],
        },
      },
    });
    const resolved = tools((catalog) => [
      "wipe",
      ...catalog.fns
        .filter((f) => f.tags?.includes("read-only"))
        .map((f) => f.name),
    ]).resolve(t.ctx);
    expect(resolved.map((r) => r.name).sort()).toEqual([
      "CurrentTime",
      "RandomUuid",
      "wipe",
    ]);
  });

  /**
   * @case Builder can walk catalog.routes and reference them via Direct(<id>)
   * @preconditions One direct route tagged "read-only"
   * @expectedResult The route surfaces as `direct_<id>` in the resolved list
   */
  test("builder maps catalog.routes to Direct(...) references", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("read-thing")
          .description("Read a thing.")
          .input(z.object({}))
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();
    const resolved = tools((catalog) =>
      catalog.routes
        .filter((r) => r.tags?.includes("read-only"))
        .map((r) => `Direct(${r.id})`),
    ).resolve(t.ctx);
    expect(resolved.map((r) => r.name)).toEqual(["direct_read-thing"]);
  });

  /**
   * @case Builder that throws is wrapped in RC5003 with the original error chained
   * @preconditions Builder synchronously throws
   * @expectedResult resolve() throws with a message including the builder's error
   */
  test("builder errors are wrapped in RC5003", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime() },
    });
    expect(() =>
      tools(() => {
        throw new Error("boom");
      }).resolve(t!.ctx),
    ).toThrow(/builder threw: boom/);
  });

  /**
   * @case Builder that returns a non-array is rejected
   * @preconditions Builder returns an object
   * @expectedResult resolve() throws clearly explaining the expected shape
   */
  test("builder must return an array", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime() },
    });
    expect(() => tools((() => ({})) as never).resolve(t!.ctx)).toThrow(
      /builder must return an array/,
    );
  });
});
