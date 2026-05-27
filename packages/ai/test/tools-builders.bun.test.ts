import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  direct,
  isAuthentic,
  isRoutecraftError,
  markAuthentic,
  log,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  currentTime,
  randomUuid,
  directTool,
  type FnEntry,
  type FnOptions,
} from "../src/index.ts";
import { isDeferredFn } from "../src/agent/tools/types.ts";
import { ADAPTER_FN_REGISTRY } from "../src/fn/store.ts";

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
   * @case directTool overrides for description and input replace the route's values
   * @preconditions directTool("fetch-order", { description, input }) overrides; route defines its own .description() and .input()
   * @expectedResult Resolved FnOptions uses the override description/input; tags pass through from the route unchanged
   */
  test("directTool overrides replace route-level description and input", async () => {
    const overrideSchema = z.object({ q: z.string() });
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              custom: directTool("fetch-order", {
                description: "OVERRIDE description.",
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
    // Tags flow through from the underlying route unchanged (no override field).
    expect(resolved.tags).toEqual(["read-only"]);
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

  /**
   * @case directTool forwards FnHandlerContext.principal to the downstream direct route's exchange
   * @preconditions Handler invoked with a principal in its ctx; downstream route captures `ex.principal`
   * @expectedResult Captured principal on the inner route equals the one from the calling tool ctx
   */
  test("dispatchDirect forwards the calling principal to the downstream exchange", async () => {
    const inputSchema = z.object({ orderId: z.string() });
    let downstreamPrincipal: unknown;
    t = await testContext()
      .routes([
        craft()
          .id("orders/fetch-with-auth")
          .description("Fetch with auth.")
          .input(inputSchema)
          .from(direct())
          .process((ex) => {
            downstreamPrincipal = ex.principal;
            return {
              ...ex,
              body: { ok: true },
            };
          })
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const principal = {
      kind: "jwt" as const,
      scheme: "bearer" as const,
      subject: "agent-caller",
      scopes: ["orders.read"],
    };
    const desc = directTool("orders/fetch-with-auth");
    const fn = desc.resolve(t.ctx, "ordersFetchWithAuth");
    await fn.handler(
      { orderId: "abc" },
      {
        logger: undefined as unknown as Parameters<
          typeof fn.handler
        >[1]["logger"],
        abortSignal: new AbortController().signal,
        principal,
      },
    );
    expect(downstreamPrincipal).toEqual(principal);
  });

  /**
   * @case directTool forwards authenticity only when the calling principal is authentic
   * @preconditions Downstream route records isAuthentic(ex.principal); handler invoked once with an authentic principal and once with a self-asserted plain object carrying the same fields
   * @expectedResult Authentic in -> authentic downstream; self-asserted in -> non-authentic downstream (no laundering across the agent -> tool boundary)
   */
  test("dispatchDirect forwards authenticity only for authentic principals", async () => {
    let downstreamAuthentic: boolean | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("guarded/echo")
          .description("Echo with auth capture.")
          .input(z.object({}))
          .from(direct())
          .process((ex) => {
            downstreamAuthentic = isAuthentic(ex.principal);
            return { ...ex, body: { ok: true } };
          })
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const desc = directTool("guarded/echo");
    const fn = desc.resolve(t.ctx, "guardedEcho");
    const base = {
      logger: undefined as unknown as Parameters<
        typeof fn.handler
      >[1]["logger"],
      abortSignal: new AbortController().signal,
    };

    await fn.handler(
      {},
      {
        ...base,
        principal: markAuthentic({
          kind: "jwt" as const,
          scheme: "bearer" as const,
          subject: "verified",
          roles: ["admin"],
        }),
      },
    );
    expect(downstreamAuthentic).toBe(true);

    downstreamAuthentic = undefined;
    await fn.handler(
      {},
      {
        ...base,
        principal: {
          kind: "jwt" as const,
          scheme: "bearer" as const,
          subject: "forged",
          roles: ["admin"],
        },
      },
    );
    expect(downstreamAuthentic).toBe(false);
  });

  /**
   * @case A self-asserted principal reaching a guarded route through directTool is rejected with RC5023
   * @preconditions Route guarded by .authorize({ roles: ["admin"] }); directTool invoked once with an authentic admin principal and once with a self-asserted (plain-object) admin principal
   * @expectedResult Authentic admin passes; self-asserted admin is rejected with RC5023 instead of being laundered into a trusted identity
   */
  test("guarded route reached through directTool rejects a self-asserted principal (RC5023)", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("guarded-admin")
          .description("Admin-only guarded tool.")
          .input(z.object({}))
          .authorize({ roles: ["admin"] })
          .from(direct())
          .process((ex) => ({ ...ex, body: { ok: true } }))
          .to(log()),
      ])
      .build();
    await t.startAndWaitReady();

    const desc = directTool("guarded-admin");
    const fn = desc.resolve(t.ctx, "guardedAdmin");
    const base = {
      logger: undefined as unknown as Parameters<
        typeof fn.handler
      >[1]["logger"],
      abortSignal: new AbortController().signal,
    };

    const authResult = await fn.handler(
      {},
      {
        ...base,
        principal: markAuthentic({
          kind: "jwt" as const,
          scheme: "bearer" as const,
          subject: "verified-admin",
          roles: ["admin"],
        }),
      },
    );
    expect(authResult).toMatchObject({ ok: true });

    let caught: unknown;
    try {
      await fn.handler(
        {},
        {
          ...base,
          principal: {
            kind: "jwt" as const,
            scheme: "bearer" as const,
            subject: "forged-admin",
            roles: ["admin"],
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5023");
  });
});

describe("tool builders - built-in fn factories", () => {
  /**
   * @case currentTime() and randomUuid() factories return eager FnOptions
   * @preconditions Call the factories directly
   * @expectedResult Both return objects with description / schema / handler / tags
   */
  test("currentTime() and randomUuid() return eager fns", () => {
    expect(currentTime()).toBeDefined();
    expect(isDeferredFn(currentTime())).toBe(false);
    const ct = currentTime() as FnOptions;
    expect(typeof ct.description).toBe("string");
    expect(typeof ct.handler).toBe("function");
    expect(ct.tags).toContain("read-only");

    expect(randomUuid()).toBeDefined();
    const ru = randomUuid() as FnOptions;
    expect(typeof ru.description).toBe("string");
    expect(typeof ru.handler).toBe("function");
  });

  /**
   * @case CurrentTime handler returns an ISO 8601 timestamp string
   * @preconditions Call currentTime().handler({}, ctx)
   * @expectedResult Returns a parseable ISO string within a second of now
   */
  test("CurrentTime handler returns a fresh ISO timestamp", async () => {
    const ct = currentTime() as FnOptions<Record<string, never>, string>;
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
