import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  defaultFns,
  directTool,
  isToolSelection,
  tools,
} from "../src/index.ts";

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
   * @preconditions tools(["currentTime"])
   * @expectedResult isToolSelection returns true; resolve is callable
   */
  test("tools() returns a branded selection descriptor", () => {
    const sel = tools(["currentTime"]);
    expect(isToolSelection(sel)).toBe(true);
    expect(typeof sel.resolve).toBe("function");
  });

  /**
   * @case tools(items) rejects non-array input
   * @preconditions tools("currentTime" as never)
   * @expectedResult RC5003 thrown synchronously
   */
  test("tools() rejects non-array input", () => {
    expect(() => tools("currentTime" as never)).toThrow(/array/i);
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
   * @preconditions agentPlugin functions includes currentTime; resolve tools(["currentTime"])
   * @expectedResult Single ResolvedTool named "currentTime" with description and handler from defaultFns
   */
  test("bare fn name resolves to a registered fn", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const resolved = tools(["currentTime"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("currentTime");
    expect(resolved[0].description).toMatch(/timestamp/i);
    expect(typeof resolved[0].handler).toBe("function");
    expect(resolved[0].tags).toContain("read-only");
  });

  /**
   * @case direct_<routeId> bare ref resolves via the direct registry
   * @preconditions Direct route "fetch-order" registered with description + input
   * @expectedResult Single ResolvedTool named "direct_fetch-order"
   */
  test("direct_<routeId> bare ref resolves via the direct registry", async () => {
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

    const resolved = tools(["direct_fetch-order"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("direct_fetch-order");
    expect(resolved[0].description).toBe("Fetch an order by id.");
    expect(resolved[0].schema).toBe(inputSchema);
  });

  /**
   * @case Fn registry entry with id "direct_x" wins over the prefix convention
   * @preconditions Route "x" registered AND fn registry entry named "direct_x" with explicit description
   * @expectedResult Resolution returns the fn registry entry (not the route-derived one)
   */
  test("explicit fn registry entry wins over the prefix convention", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              direct_x: {
                description: "Explicit fn registry entry.",
                schema: z.object({}),
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

    const [resolved] = tools(["direct_x"]).resolve(t.ctx);
    expect(resolved.description).toBe("Explicit fn registry entry.");
  });

  /**
   * @case Unknown bare name throws RC5003
   * @preconditions agentPlugin without "missing"; resolve tools(["missing"])
   * @expectedResult RC5003 thrown listing available names
   */
  test("unknown bare name throws RC5003", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    let caught: unknown;
    try {
      tools(["missing"]).resolve(t.ctx);
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5003");
    expect((caught as Error).message).toMatch(/missing/);
    expect((caught as Error).message).toMatch(/currentTime|randomUuid/);
  });

  /**
   * @case agent_<id> reference surfaces a clear "story F" error
   * @preconditions resolve tools(["agent_researcher"])
   * @expectedResult RC5003 thrown mentioning sub-agent / follow-up story
   */
  test("agent_<id> bare ref throws not-yet-supported", async () => {
    t = await buildCtx({});
    expect(() => tools(["agent_researcher"]).resolve(t!.ctx)).toThrow(
      /sub-agent|follow-up/i,
    );
  });

  /**
   * @case mcp_<server>_<tool> reference surfaces a clear "story E" error
   * @preconditions resolve tools(["mcp_brave_search"])
   * @expectedResult RC5003 thrown mentioning MCP / follow-up story
   */
  test("mcp_<...> bare ref throws not-yet-supported", async () => {
    t = await buildCtx({});
    expect(() => tools(["mcp_brave_search"]).resolve(t!.ctx)).toThrow(
      /MCP|follow-up/i,
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
   * @preconditions tools([{ name: "currentTime", guard: g }]) with currentTime registered
   * @expectedResult ResolvedTool.guard is the supplied function
   */
  test("{ name, guard } attaches the guard", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const guard = vi.fn();
    const [resolved] = tools([{ name: "currentTime", guard }]).resolve(t.ctx);
    expect(resolved.name).toBe("currentTime");
    expect(resolved.guard).toBe(guard);
  });

  /**
   * @case { name } with empty/blank string throws
   * @preconditions tools([{ name: "" }])
   * @expectedResult RC5003 thrown synchronously at resolve
   */
  test("{ name } rejects empty string", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    expect(() => tools([{ name: "" }]).resolve(t!.ctx)).toThrow(/non-empty/i);
  });
});

describe("tools() resolver - tag selectors", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Single-tag selector matches eager fn registry entries
   * @preconditions defaultFns spread (currentTime + randomUuid both tagged "read-only")
   * @expectedResult { tagged: "read-only" } resolves to both fns
   */
  test("{ tagged } matches eager fn registry entries", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["currentTime", "randomUuid"]);
  });

  /**
   * @case Tag selector matches direct routes via the direct registry
   * @preconditions Two direct routes; one tagged "read-only", one untagged
   * @expectedResult Selector resolves to one ResolvedTool named "direct_<id>"
   */
  test("{ tagged } matches direct routes via the direct registry", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("read-thing")
          .description("Read a thing.")
          .input(z.object({}))
          .tag("read-only")
          .from(direct())
          .to(log()),
        craft()
          .id("untagged")
          .description("Other thing.")
          .input(z.object({}))
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    expect(resolved.map((r) => r.name)).toEqual(["direct_read-thing"]);
  });

  /**
   * @case OR-of-tags: matches entries with ANY of the requested tags
   * @preconditions defaultFns (read-only, idempotent for currentTime; read-only for randomUuid) + a fn tagged only "destructive"
   * @expectedResult { tagged: ["idempotent", "destructive"] } returns currentTime and the destructive fn but not randomUuid
   */
  test("{ tagged: [...] } is an OR over the listed tags", async () => {
    t = await buildCtx({
      functions: {
        ...defaultFns,
        wipe: {
          description: "Wipe data.",
          schema: z.object({}),
          handler: () => "ok",
          tags: ["destructive"],
        },
      },
    });
    const resolved = tools([{ tagged: ["idempotent", "destructive"] }]).resolve(
      t.ctx,
    );
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["currentTime", "wipe"]);
  });

  /**
   * @case Tag-zero-match returns nothing and does not throw
   * @preconditions No registered entry has tag "ghost"
   * @expectedResult tools([{ tagged: "ghost" }]).resolve() returns []
   */
  test("tag-zero-match returns nothing without throwing", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const resolved = tools([{ tagged: "ghost" }]).resolve(t.ctx);
    expect(resolved).toEqual([]);
  });

  /**
   * @case Tag selector applies its guard to every matched tool
   * @preconditions tools([{ tagged: "read-only", guard: g }]); 2 fns matched
   * @expectedResult Both ResolvedTools have ResolvedTool.guard === g
   */
  test("tag selector guard applies to every matched tool", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const guard = vi.fn();
    const resolved = tools([{ tagged: "read-only", guard }]).resolve(t.ctx);
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    for (const tool of resolved) expect(tool.guard).toBe(guard);
  });

  /**
   * @case Explicit refs win over tag-selector matches regardless of order
   * @preconditions Tag selector matches "currentTime"; later (or earlier) explicit ref overrides with a different guard
   * @expectedResult Final list contains "currentTime" with the explicit guard
   */
  test("explicit refs win over tag-selector matches", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const explicitGuard = vi.fn();
    const tagGuard = vi.fn();
    const resolved = tools([
      { tagged: "read-only", guard: tagGuard },
      { name: "currentTime", guard: explicitGuard },
    ]).resolve(t.ctx);
    const ct = resolved.find((r) => r.name === "currentTime");
    expect(ct?.guard).toBe(explicitGuard);
  });
});

describe("tools() resolver - dedup and prefix-convention coverage", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Same tool referenced twice surfaces only once
   * @preconditions tools(["currentTime", "currentTime"])
   * @expectedResult Single ResolvedTool
   */
  test("duplicate explicit refs are deduplicated", async () => {
    t = await buildCtx({ functions: { ...defaultFns } });
    const resolved = tools(["currentTime", "currentTime"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
  });

  /**
   * @case A directTool wrapper in functions and a direct route under the same name surface once
   * @preconditions Route "fetch-order" + functions: { fetchOrder: directTool("fetch-order") }; tag "read-only" on both
   * @expectedResult { tagged: "read-only" } returns one entry per tool name (no double include)
   */
  test("directTool fn registry wrapper supersedes the same direct route at tag matching", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              fetchOrder: directTool("fetch-order"),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("fetch-order")
          .description("Fetch an order.")
          .input(z.object({ orderId: z.string() }))
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name);
    expect(names).toContain("fetchOrder");
    expect(names).not.toContain("direct_fetch-order");
  });
});
