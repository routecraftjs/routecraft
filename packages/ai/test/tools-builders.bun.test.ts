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
import { agentPlugin, directTool, tools, type FnEntry } from "../src/index.ts";
import { isDeferredFn } from "../src/agent/tools/types.ts";
import { ADAPTER_FN_REGISTRY } from "../src/fn/store.ts";

/** Suspension is not under test in this file; the required slot just refuses. */
const refuseSuspend = (): never => {
  throw new Error("suspension not under test");
};

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
      FnEntry | undefined;
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
   * @case An unknown route id fails the boot rather than the first dispatch
   * @preconditions directTool("does-not-exist") with no matching route
   * @expectedResult startup rejects with RC5003 naming the missing id and listing the ids that do exist
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

    // ctx.start() rather than startAndWaitReady(): the helper awaits route
    // readiness, and a plugin's start() hook runs after that, so the boot
    // failure lands on the start promise the helper deliberately shields.
    let caught: unknown;
    try {
      await t.ctx.start();
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5003");
    expect((caught as Error).message).toMatch(/does-not-exist/);
    expect((caught as Error).message).toMatch(/real-route/);
  });

  /**
   * @case A route with no description fails the boot
   * @preconditions Route lacks .description(); no description override on directTool
   * @expectedResult startup rejects with a message naming the missing description
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
    await expect(t.ctx.start()).rejects.toThrow(/description/i);
  });

  /**
   * @case A route with no input schema fails the boot
   * @preconditions Route has .description() but no .input(); no schema override
   * @expectedResult startup rejects with a message naming the missing input schema
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
    await expect(t.ctx.start()).rejects.toThrow(/input/i);
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
        suspend: refuseSuspend,
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
        suspend: refuseSuspend,
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
      suspend: refuseSuspend,
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
    // Explicit generic: control flow narrowed the binding to `undefined`
    // after the reset above, and TS does not track the handler's assignment.
    expect<boolean | undefined>(downstreamAuthentic).toBe(false);
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
      suspend: refuseSuspend,
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

/**
 * A lazily-resolved tool must be indistinguishable from an eagerly
 * authored one on every path that reads a tool's declared fields.
 *
 * The bug these cover was not a missing feature but an ordering
 * shortcut: paths that read the registry entry before resolution saw a
 * thunk carrying nothing and reported that absence as a property of the
 * tool. Each test below reads one such path and asserts the route-backed
 * tool answers exactly as a hand-written one does.
 */
describe("tool builders - a deferred tool is not a lesser tool", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const bashRoute = () =>
    craft()
      .id("bash-runner")
      .description("Run a shell command")
      .input(z.object({ command: z.string() }))
      .tag("host")
      .from(direct())
      .to(log());

  /**
   * @case The tools catalogue reports a route-backed tool's own description and tags
   * @preconditions A directTool registered as Bash over a route carrying .description() and .tag()
   * @expectedResult The catalogue entry carries the route's description and tags, so a builder filtering on either still sees it
   */
  test("the catalogue reports a deferred tool's declared fields", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Bash: directTool("bash-runner") } }),
        ],
      })
      .routes([bashRoute()])
      .build();
    await t.startAndWaitReady();

    let seen: {
      name: string;
      description?: string;
      tags?: readonly string[];
    }[] = [];
    const selection = tools((catalog) => {
      seen = catalog.fns.map((fn) => ({ ...fn }));
      return ["Bash"];
    });
    selection.resolve(t.ctx);

    const bash = seen.find((fn) => fn.name === "Bash");
    expect(bash?.description).toBe("Run a shell command");
    expect(bash?.tags).toEqual(["host"]);
  });

  /**
   * @case A builder filtering the catalogue by tag selects a route-backed tool
   * @preconditions The same registration, with a builder keeping only tools tagged "host"
   * @expectedResult Bash is selected, where reading the entry raw would have filtered it out silently
   */
  test("a tag filter reaches a deferred tool", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Bash: directTool("bash-runner") } }),
        ],
      })
      .routes([bashRoute()])
      .build();
    await t.startAndWaitReady();

    const selection = tools((catalog) =>
      catalog.fns
        .filter((fn) => fn.tags?.includes("host"))
        .map((fn) => fn.name),
    );
    expect(selection.resolve(t.ctx).map((tool) => tool.name)).toEqual(["Bash"]);
  });

  /**
   * @case The registration announcement carries a route-backed tool's own description
   * @preconditions The same registration; agent:tool:registered observed across a full start
   * @expectedResult The announced tool carries the route's description, the same shape an eagerly authored tool announces
   */
  test("the registration event announces a deferred tool's description", async () => {
    const announced: unknown[] = [];
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Bash: directTool("bash-runner") } }),
        ],
      })
      .routes([bashRoute()])
      .build();
    t.ctx.on(
      "agent:tool:registered" as never,
      ({ details }: { details: unknown }) => {
        announced.push(details);
      },
    );
    await t.startAndWaitReady();

    const bash = announced.find(
      (d) => (d as { toolName?: string })?.toolName === "Bash",
    ) as { description?: string; tags?: readonly string[] } | undefined;
    expect(bash).toBeDefined();
    expect(bash?.description).toBe("Run a shell command");
    expect(bash?.tags).toEqual(["host"]);
  });

  /**
   * @case A tool naming a route that does not exist fails the boot
   * @preconditions directTool("no-such-route") registered, with no such route
   * @expectedResult context.start() rejects naming the unknown route id, rather than deferring the failure to the agent's first tool call
   */
  test("an unresolvable tool fails startup, not the first dispatch", async () => {
    const built = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Missing: directTool("no-such-route") } }),
        ],
      })
      .routes([bashRoute()])
      .build();
    await expect(built.ctx.start()).rejects.toThrow(/no-such-route/);
    await built.stop();
  });

  /**
   * @case A tool naming an internal route fails the boot with the boundary-route guidance
   * @preconditions A route with direct({ internal: true }) carrying .description() and .input(), and a directTool naming it
   * @expectedResult context.start() rejects naming internal-ness and the boundary-route remedy, not the "unknown route id" advice: the route exists and adding metadata would not make it a tool
   */
  test("a tool naming an internal route fails startup with the boundary guidance", async () => {
    const built = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Hidden: directTool("subroutine") } }),
        ],
      })
      .routes([
        craft()
          .id("subroutine")
          .description("Trusting subroutine")
          .input({ body: z.object({ n: z.number() }) })
          .from(direct({ internal: true }))
          .transform((body) => body),
      ])
      .build();
    await expect(built.ctx.start()).rejects.toThrow(
      /internal.*boundary route/s,
    );
    await built.stop();
  });

  /**
   * @case A route failure behind a deferred tool reaches the caller as an ordinary route error
   * @preconditions Bash granted over a route whose input schema rejects the call
   * @expectedResult The handler rejects rather than returning, with no deferred-tool special casing in the failure
   */
  test("a route failure propagates through a deferred tool", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Bash: directTool("bash-runner") } }),
        ],
      })
      .routes([bashRoute()])
      .build();
    await t.startAndWaitReady();

    const [bash] = tools(["Bash"]).resolve(t.ctx);
    expect(bash).toBeDefined();
    await expect(
      bash!.handler(
        { command: 42 } as never,
        {
          suspend: refuseSuspend,
        } as never,
      ),
    ).rejects.toThrow();
  });
});
