import { describe, test, expect, afterEach } from "vitest";
import { z } from "zod";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  agentTool,
  defaultFns,
  directTool,
  isDeferredFn,
  mcpTool,
  ADAPTER_FN_REGISTRY,
  type FnEntry,
  type FnOptions,
} from "../src/index.ts";

describe("tool builders - directTool", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case directTool returns a deferred descriptor branded as a fn entry
   * @preconditions directTool("any-route")
   * @expectedResult isDeferredFn returns true; kind === "direct"
   */
  test("directTool returns a deferred descriptor", () => {
    const desc = directTool("fetch-order");
    expect(isDeferredFn(desc)).toBe(true);
    expect(desc.kind).toBe("direct");
  });

  /**
   * @case directTool rejects empty/blank routeId
   * @preconditions directTool("")
   * @expectedResult RC5003 thrown synchronously at builder call
   */
  test("directTool throws on empty routeId", () => {
    expect(() => directTool("")).toThrow(/routeId/i);
    expect(() => directTool("   ")).toThrow(/routeId/i);
  });

  /**
   * @case directTool override tags are trimmed at builder time
   * @preconditions directTool("x", { tags: ["  read-only  "] })
   * @expectedResult overrideTags on the descriptor is ["read-only"]
   */
  test("directTool trims override tags at builder time", () => {
    const desc = directTool("x", { tags: ["  read-only  ", "data"] });
    expect(desc.overrideTags).toEqual(["read-only", "data"]);
  });

  /**
   * @case directTool override tags reject non-array and empty/blank entries
   * @preconditions directTool with malformed tags overrides
   * @expectedResult RC5003 thrown synchronously at builder call
   */
  test("directTool rejects malformed override tags", () => {
    expect(() =>
      directTool("x", { tags: "read-only" as unknown as string[] }),
    ).toThrow(/tags/i);
    expect(() => directTool("x", { tags: ["read-only", ""] })).toThrow(
      /non-empty/i,
    );
    expect(() => directTool("x", { tags: ["   "] })).toThrow(/non-empty/i);
  });

  /**
   * @case directTool resolves at dispatch time using the direct registry
   * @preconditions Route registered with .description() and .input(); directTool referenced from agentPlugin functions
   * @expectedResult Resolution returns FnOptions with description, schema, and tags pulled from the route
   */
  test("directTool resolves to FnOptions from the direct registry", async () => {
    const inputSchema = z.object({ orderId: z.string() });

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
          .description("Fetch an order by id from the orders DB.")
          .input(inputSchema)
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("fetchOrder") as
      | FnEntry
      | undefined;
    expect(entry).toBeDefined();
    expect(isDeferredFn(entry!)).toBe(true);

    if (!isDeferredFn(entry!)) throw new Error("expected deferred entry");
    const resolved = entry.resolve(t.ctx, "fetchOrder");
    expect(resolved.description).toBe(
      "Fetch an order by id from the orders DB.",
    );
    expect(resolved.input).toBe(inputSchema);
    expect(resolved.tags).toEqual(["read-only"]);
    expect(typeof resolved.handler).toBe("function");
  });

  /**
   * @case directTool overrides replace, do not merge
   * @preconditions directTool("fetch-order", { description, tags }) overrides; route defines its own .description() and .tag()
   * @expectedResult Resolved FnOptions uses the override values exactly
   */
  test("directTool overrides replace route-level values", async () => {
    const overrideSchema = z.object({ q: z.string() });
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              custom: directTool("fetch-order", {
                description: "OVERRIDE description.",
                tags: ["destructive"],
                input: overrideSchema,
              }),
            },
          }),
        ],
      })
      .routes([
        craft()
          .id("fetch-order")
          .description("Original description.")
          .input(z.object({ orderId: z.string() }))
          .tag("read-only")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("custom");
    if (!entry || !isDeferredFn(entry)) throw new Error("expected deferred");
    const resolved = entry.resolve(t.ctx, "custom");
    expect(resolved.description).toBe("OVERRIDE description.");
    expect(resolved.input).toBe(overrideSchema);
    expect(resolved.tags).toEqual(["destructive"]);
  });

  /**
   * @case directTool throws RC5003 at resolution when the route id is unknown
   * @preconditions directTool("does-not-exist") with no matching route
   * @expectedResult resolve() throws RC5003 listing known route ids
   */
  test("directTool resolution throws on unknown route id", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { broken: directTool("does-not-exist") },
          }),
        ],
      })
      .routes([
        craft().id("real-route").description("...").from(direct()).to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("broken");
    if (!entry || !isDeferredFn(entry)) throw new Error("expected deferred");
    let caught: unknown;
    try {
      entry.resolve(t.ctx, "broken");
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5003");
    expect((caught as Error).message).toMatch(/does-not-exist/);
    expect((caught as Error).message).toMatch(/real-route/);
  });

  /**
   * @case directTool resolution throws RC5003 when the underlying route has no description
   * @preconditions Route lacks .description(); no description override on directTool
   * @expectedResult resolve() throws RC5003 mentioning the route id
   */
  test("directTool resolution throws when route has no description", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { needsDesc: directTool("no-desc") },
          }),
        ],
      })
      .routes([
        craft().id("no-desc").input(z.object({})).from(direct()).to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("needsDesc");
    if (!entry || !isDeferredFn(entry)) throw new Error("expected deferred");
    expect(() => entry.resolve(t!.ctx, "needsDesc")).toThrow(/description/i);
  });

  /**
   * @case directTool resolution throws RC5003 when the route has no input schema
   * @preconditions Route has .description() but no .input(); no schema override
   * @expectedResult resolve() throws RC5003 mentioning input
   */
  test("directTool resolution throws when route has no input schema", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { needsSchema: directTool("no-input") },
          }),
        ],
      })
      .routes([
        craft()
          .id("no-input")
          .description("Route with no input schema.")
          .from(direct())
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("needsSchema");
    if (!entry || !isDeferredFn(entry)) throw new Error("expected deferred");
    expect(() => entry.resolve(t!.ctx, "needsSchema")).toThrow(/input/i);
  });
});

describe("tool builders - directTool dispatch", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case directTool dispatch sanitizes the endpoint when sending into a direct route
   * @preconditions Direct route id contains characters that `encodeURIComponent` rewrites (e.g. "/")
   * @expectedResult Handler dispatches into the route via the sanitised endpoint and returns the route body
   */
  test("dispatchDirect sanitizes the endpoint before send", async () => {
    const inputSchema = z.object({ orderId: z.string() });
    t = await testContext()
      .routes([
        craft()
          .id("orders/fetch")
          .description("Fetch an order from the orders subsystem.")
          .input(inputSchema)
          .from(direct())
          .process((ex) => ({
            ...ex,
            body: {
              orderId: (ex.body as { orderId: string }).orderId,
              ok: true,
            },
          }))
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const desc = directTool("orders/fetch");
    const fn = desc.resolve(t.ctx, "ordersFetch");
    const result = await fn.handler(
      { orderId: "abc" },
      {
        logger: undefined as unknown as Parameters<
          typeof fn.handler
        >[1]["logger"],
        abortSignal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ orderId: "abc", ok: true });
  });
});

describe("tool builders - agentTool stub", () => {
  /**
   * @case agentTool returns a deferred descriptor whose resolve throws
   * @preconditions agentTool("researcher")
   * @expectedResult deferred kind === "agent"; resolve throws RC5003 mentioning the story
   */
  test("agentTool returns a deferred descriptor that resolves to a not-yet-supported error", () => {
    const desc = agentTool("researcher");
    expect(desc.kind).toBe("agent");
    expect(() => desc.resolve(undefined as never, "research")).toThrow(
      /not yet supported/i,
    );
  });

  /**
   * @case agentTool throws on empty agentId at build time
   * @preconditions agentTool("")
   * @expectedResult RC5003 thrown synchronously
   */
  test("agentTool throws on empty agentId", () => {
    expect(() => agentTool("")).toThrow(/agentId/i);
  });
});

describe("tool builders - mcpTool stub", () => {
  /**
   * @case mcpTool returns a deferred descriptor whose resolve throws
   * @preconditions mcpTool("brave", "search")
   * @expectedResult deferred kind === "mcp"; resolve throws RC5003 mentioning the story
   */
  test("mcpTool returns a deferred descriptor that resolves to a not-yet-supported error", () => {
    const desc = mcpTool("brave", "search");
    expect(desc.kind).toBe("mcp");
    expect(() => desc.resolve(undefined as never, "searchWeb")).toThrow(
      /not yet supported/i,
    );
  });

  /**
   * @case mcpTool throws on empty serverId or toolName
   * @preconditions mcpTool with blank inputs
   * @expectedResult RC5003 thrown synchronously
   */
  test("mcpTool throws on empty serverId / toolName", () => {
    expect(() => mcpTool("", "search")).toThrow(/serverId/i);
    expect(() => mcpTool("brave", "")).toThrow(/toolName/i);
  });
});

describe("tool builders - defaultFns", () => {
  /**
   * @case defaultFns ships currentTime and randomUuid as eager FnOptions
   * @preconditions Spread defaultFns into agentPlugin.functions
   * @expectedResult Both registered, both have description / schema / handler / tags
   */
  test("defaultFns provides currentTime and randomUuid as eager fns", () => {
    expect(defaultFns.currentTime).toBeDefined();
    expect(isDeferredFn(defaultFns.currentTime!)).toBe(false);
    const ct = defaultFns.currentTime as FnOptions;
    expect(typeof ct.description).toBe("string");
    expect(typeof ct.handler).toBe("function");
    expect(ct.tags).toContain("read-only");

    expect(defaultFns.randomUuid).toBeDefined();
    const ru = defaultFns.randomUuid as FnOptions;
    expect(typeof ru.description).toBe("string");
    expect(typeof ru.handler).toBe("function");
  });

  /**
   * @case currentTime handler returns an ISO 8601 timestamp string
   * @preconditions Call defaultFns.currentTime.handler({}, ctx)
   * @expectedResult Returns a parseable ISO string within a second of now
   */
  test("currentTime handler returns a fresh ISO timestamp", async () => {
    const ct = defaultFns.currentTime as FnOptions<
      Record<string, never>,
      string
    >;
    const before = Date.now();
    const out = await ct.handler(
      {},
      {
        logger: undefined as unknown as Parameters<
          typeof ct.handler
        >[1]["logger"],
        abortSignal: new AbortController().signal,
      },
    );
    const after = Date.now();
    const parsed = Date.parse(out);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
