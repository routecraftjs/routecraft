import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  currentTime,
  randomUuid,
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

describe("tools() resolver - tag selectors", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Single-tag selector matches eager fn registry entries
   * @preconditions currentTime() + randomUuid() registered (both tagged "read-only")
   * @expectedResult { tagged: "read-only" } resolves to both fns
   */
  test("{ tagged } matches eager fn registry entries", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["CurrentTime", "RandomUuid"]);
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
   * @preconditions currentTime() (read-only, idempotent) + randomUuid() (read-only) + a fn tagged only "destructive"
   * @expectedResult { tagged: ["idempotent", "destructive"] } returns CurrentTime and the destructive fn but not RandomUuid
   */
  test("{ tagged: [...] } is an OR over the listed tags", async () => {
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
    const resolved = tools([{ tagged: ["idempotent", "destructive"] }]).resolve(
      t.ctx,
    );
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["CurrentTime", "wipe"]);
  });

  /**
   * @case Tag-zero-match throws RC5003 so a misconfigured tag never silently no-ops
   * @preconditions No registered entry has tag "ghost"
   * @expectedResult tools([{ tagged: "ghost" }]).resolve() throws RC5003 naming the tag
   */
  test("tag-zero-match throws RC5003", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    expect(() => tools([{ tagged: "ghost" }]).resolve(t!.ctx)).toThrow(
      /matched no tools/,
    );
  });

  /**
   * @case Tag selector applies its guard to every matched tool
   * @preconditions tools([{ tagged: "read-only", guard: g }]); 2 fns matched
   * @expectedResult Both ResolvedTools have ResolvedTool.guard === g
   */
  test("tag selector guard applies to every matched tool", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const guard = mock();
    const resolved = tools([{ tagged: "read-only", guard }]).resolve(t.ctx);
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    for (const tool of resolved) expect(tool.guard).toBe(guard);
  });

  /**
   * @case Explicit refs win over tag-selector matches regardless of order
   * @preconditions Tag selector matches "CurrentTime"; later (or earlier) explicit ref overrides with a different guard
   * @expectedResult Final list contains "CurrentTime" with the explicit guard
   */
  test("explicit refs win over tag-selector matches", async () => {
    t = await buildCtx({
      functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
    });
    const explicitGuard = mock();
    const tagGuard = mock();
    const resolved = tools([
      { tagged: "read-only", guard: tagGuard },
      { name: "CurrentTime", guard: explicitGuard },
    ]).resolve(t.ctx);
    const ct = resolved.find((r) => r.name === "CurrentTime");
    expect(ct?.guard).toBe(explicitGuard);
  });
});

describe("tools() resolver - regression", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Tag selectors must NOT throw when a misconfigured directTool wrapper is in the registry; only explicit refs throw
   * @preconditions functions: { broken: directTool("does-not-exist") }; tag selector that matches eager fns
   * @expectedResult Selector returns the eager match; broken wrapper is silently skipped because its underlying route has no matching tag
   */
  test("tag walk silently skips a directTool wrapper when its target route is missing", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              CurrentTime: currentTime(),
              RandomUuid: randomUuid(),
              broken: directTool("does-not-exist"),
            },
          }),
        ],
      })
      .build();

    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["CurrentTime", "RandomUuid"]);
  });

  /**
   * @case Tools item that is an object lacking both name and tagged is rejected
   * @preconditions tools([{ guard: () => {} } as never])
   * @expectedResult RC5003 thrown when resolve() runs
   */
  test("tools() throws on object items lacking both name and tagged", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { CurrentTime: currentTime(), RandomUuid: randomUuid() },
          }),
        ],
      })
      .build();

    expect(() =>
      tools([{ guard: () => undefined } as never]).resolve(t!.ctx),
    ).toThrow(/name.*tagged|tagged.*name/i);
  });

  /**
   * @case directTool override tags drive tag selection
   * @preconditions Route tagged "read-only"; functions: { safeFetch: directTool("fetch-source", { tags: ["safe"] }) }; selector { tagged: "safe" }
   * @expectedResult Wrapper "safeFetch" is included via the override tag, even though the underlying route doesn't carry "safe"
   */
  test("tag walk respects directTool override tags", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              safeFetch: directTool("fetch-source", { tags: ["safe"] }),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("fetch-source")
          .description("Fetch a source.")
          .input(z.object({}))
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const resolved = tools([{ tagged: "safe" }]).resolve(t.ctx);
    expect(resolved.map((r) => r.name)).toContain("safeFetch");
  });

  /**
   * @case directTool with override tags hides itself from selectors that match the underlying route's tags
   * @preconditions Route tagged "read-only"; wrapper directTool with tags: ["safe"] (read-only NOT included); selector { tagged: "read-only" }
   * @expectedResult Wrapper not included (its overrides don't carry read-only); underlying route surfaces under direct_<id>
   */
  test("directTool override tags replace the route's tags for matching", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              safeFetch: directTool("fetch-source", { tags: ["safe"] }),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("fetch-source")
          .description("Fetch a source.")
          .input(z.object({}))
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name);
    expect(names).not.toContain("safeFetch");
    expect(names).toContain("direct_fetch-source");
  });

  /**
   * @case Whitespace-surrounded fn tag is trimmed at storage so exact selectors match
   * @preconditions Fn registered with tags: [" read-only "]
   * @expectedResult { tagged: "read-only" } matches the fn
   */
  test("fn tags are trimmed at storage", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              padded: {
                description: "x",
                input: currentTime().input,
                handler: () => "ok",
                tags: ["  read-only  "],
              },
            },
          }),
        ],
      })
      .build();

    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    expect(resolved.map((r) => r.name)).toContain("padded");
  });
});

describe("tools() resolver - dedup and direct-route surfacing coverage", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Same tool referenced twice surfaces only once
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

  /**
   * @case Same dedup holds for route ids that include URL-special characters (the direct registry stores them sanitised, but the wrapper carries the raw id)
   * @preconditions Route "orders/fetch" tagged "read-only"; functions: { ordersFetch: directTool("orders/fetch") }; tag selector { tagged: "read-only" }
   * @expectedResult Only the fn-registry wrapper "ordersFetch" surfaces; the sanitised `direct_orders%2Ffetch` form is suppressed (dedup compares sanitised on both sides)
   */
  test("directTool fn registry wrapper supersedes the same direct route even when the route id contains URL-special characters", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              ordersFetch: directTool("orders/fetch"),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("orders/fetch")
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
    expect(names).toContain("ordersFetch");
    expect(names).not.toContain("direct_orders/fetch");
    expect(names).not.toContain("direct_orders%2Ffetch");
  });
});
