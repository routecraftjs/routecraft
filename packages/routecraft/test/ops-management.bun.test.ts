import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  apiKey,
  craft,
  cron,
  direct,
  noop,
  opsPlugin,
  type HttpAuth,
  type OpsPage,
  type OpsRouteDetail,
  type OpsRouteSummary,
  type OpsTiers,
  type Principal,
} from "../src/index.ts";

/**
 * The management API on the ops server: the three resources, the tiers that
 * gate them, and the paging discipline the collections carry.
 *
 * The cases that matter most are the refusals. A management surface that
 * works is easy to prove and easy to get wrong in the one direction nobody
 * notices, so every tier here is exercised from the outside with a
 * credential that should not reach it as well as one that should.
 */

const SUSPENSION_SECRET = "ops-management-suspension-secret-0123456789";

/** Whatever the test harness accepts as a route list. */
type Routes = Parameters<ReturnType<typeof testContext>["routes"]>[0];

/**
 * Per-key identities, standing in for the IdP an app would normally carry.
 * Three so the interesting case is expressible: a credential that is valid
 * and admitted, and still may not dispatch.
 */
const KEYS: Record<string, string[]> = {
  reader: ["ops:introspection"],
  operator: ["ops:introspection", "ops:dispatch"],
  nobody: [],
};

function keyAuth(): HttpAuth {
  return apiKey({
    verify: (key: string): Principal | null => {
      const scopes = KEYS[key];
      if (scopes === undefined) return null;
      return { kind: "custom", scheme: "apiKey", subject: key, scopes };
    },
  });
}

interface Fetched<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T>(
  port: number,
  path: string,
  init: { method?: string; key?: string; body?: unknown } = {},
): Promise<Fetched<T>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: init.key === undefined ? {} : { "x-api-key": init.key },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
    headers: res.headers,
  };
}

describe("the ops management API", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * Start a context carrying the ops mount and return its bound port. Port
   * 0 asks the OS for a free one, and the resolved port arrives on
   * `server:listening`, the same event an operator would read.
   */
  async function start(options: {
    tiers?: OpsTiers;
    auth?: HttpAuth | false;
    routes?: Routes;
    suspension?: boolean;
  }): Promise<number> {
    const builder = testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        ...(options.suspension
          ? {
              suspension: {
                store: new MemorySuspensionStore(),
                secret: SUSPENSION_SECRET,
              },
            }
          : {}),
        plugins: [
          opsPlugin({
            ...(options.tiers !== undefined ? { tiers: options.tiers } : {}),
            ...(options.auth !== undefined ? { auth: options.auth } : {}),
          }),
        ],
      })
      .routes(
        options.routes ?? [craft().id("worker").from(direct()).to(noop())],
      );

    t = await builder.build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  /**
   * @case An app that configures no tiers answers 404 on every management path
   * @preconditions opsPlugin with no `tiers`, one dispatchable route present
   * @expectedResult 404 on the collection, the detail and the dispatch path. Secure by default is the whole posture: an unconfigured instance must disclose neither its route inventory nor that a management surface exists at all
   */
  test("answers 404 on every tier when nothing is configured", async () => {
    const port = await start({});

    for (const path of ["/ops/routes", "/ops/routes/worker"]) {
      const { status } = await call(port, path);
      expect(status).toBe(404);
    }
    const dispatch = await call(port, "/ops/routes/worker/exchanges", {
      method: "POST",
      body: {},
    });
    expect(dispatch.status).toBe(404);
  });

  /**
   * @case Health keeps answering while every management tier is off
   * @preconditions No tiers configured
   * @expectedResult /health answers 200. The two surfaces have opposite postures on one mount, and turning management off must not take the orchestrator's probe with it
   */
  test("serves health while management is disabled", async () => {
    const port = await start({});
    const { status } = await call(port, "/health");
    expect(status).toBe(200);
  });

  /**
   * @case A `true` tier is open and needs no credential
   * @preconditions tiers.introspection true, no auth configured anywhere
   * @expectedResult 200 with the route listed. `true` is the named opt-out from the secure default, and it must work on an app with no validator at all
   */
  test("serves an open tier without a credential", async () => {
    const port = await start({ tiers: { introspection: true } });
    const { status, body } = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes",
    );
    expect(status).toBe(200);
    expect(body.items.map((route) => route.id)).toEqual(["worker"]);
  });

  /**
   * @case A scope-gated tier refuses a caller carrying no credential
   * @preconditions tiers.introspection set to a scope, apiKey validator on the mount, request sends no key
   * @expectedResult 401 with the shared missing-credential wire shape, so a client can tell "authenticate" from "you may not"
   */
  test("refuses a credential-free caller on a scope-gated tier", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: { introspection: "ops:introspection" },
    });
    const { status, body } = await call<{ error: string; reason: string }>(
      port,
      "/ops/routes",
    );
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  /**
   * @case A scope-gated tier admits a principal carrying the scope
   * @preconditions tiers.introspection "ops:introspection", caller presents the reader key
   * @expectedResult 200 with the collection
   */
  test("admits a principal carrying the tier's scope", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: { introspection: "ops:introspection" },
    });
    const { status, body } = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes",
      { key: "reader" },
    );
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  /**
   * @case A valid credential lacking the scope is refused, distinguishably
   * @preconditions tiers.introspection "ops:introspection", caller presents the nobody key, which authenticates but carries no scopes
   * @expectedResult 403 with reason insufficient_scope and the scope named. The identity is fine and the credential is not, which is a different remedy from re-authenticating
   */
  test("refuses an admitted principal that lacks the scope", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: { introspection: "ops:introspection" },
    });
    const { status, body } = await call<{ reason: string; scope: string }>(
      port,
      "/ops/routes",
      { key: "nobody" },
    );
    expect(status).toBe(403);
    expect(body.reason).toBe("insufficient_scope");
    expect(body.scope).toBe("ops:introspection");
  });

  /**
   * @case A token holding only introspection may not dispatch
   * @preconditions Both tiers scope-gated, caller presents the reader key, which carries introspection and not dispatch
   * @expectedResult Introspection answers 200 and dispatch answers 403 naming the dispatch scope. Dispatch is always its own scope and never rides along with introspection, which is the single property this tier split exists to hold
   */
  test("refuses dispatch to a token holding only the introspection scope", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: {
        introspection: "ops:introspection",
        dispatch: "ops:dispatch",
      },
    });

    const read = await call(port, "/ops/routes", { key: "reader" });
    expect(read.status).toBe(200);

    const dispatch = await call<{ reason: string; scope: string }>(
      port,
      "/ops/routes/worker/exchanges",
      { method: "POST", key: "reader", body: { hello: "world" } },
    );
    expect(dispatch.status).toBe(403);
    expect(dispatch.body.reason).toBe("insufficient_scope");
    expect(dispatch.body.scope).toBe("ops:dispatch");
  });

  /**
   * @case A statically allowlisted api key can carry scopes
   * @preconditions apiKey({ keys, scopes }) on the mount, a scope-gated tier naming one of them
   * @expectedResult 200. Without this a non-IdP deployment could authenticate but never satisfy a scope check, which would leave the tier vocabulary usable only by apps with an identity provider
   */
  test("admits a static api key carrying the tier's scope", async () => {
    const port = await start({
      auth: apiKey({ keys: ["static-key"], scopes: ["ops:introspection"] }),
      tiers: { introspection: "ops:introspection" },
    });
    const { status } = await call(port, "/ops/routes", { key: "static-key" });
    expect(status).toBe(200);
  });

  /**
   * @case Dispatchability is observed, and reported per route
   * @preconditions One direct()-sourced route and one cron()-sourced route
   * @expectedResult The direct route reports dispatchable true and the cron route false, each carrying its source kind. A cron route has no door for an exchange to arrive through, and saying so on the representation is what lets one collection serve both clients
   */
  test("reports dispatchability and source kind per route", async () => {
    const port = await start({
      tiers: { introspection: true },
      routes: [
        craft().id("callable").from(direct()).to(noop()),
        craft().id("scheduled").from(cron("0 0 * * *")).to(noop()),
      ],
    });
    const { body } = await call<OpsPage<OpsRouteSummary>>(port, "/ops/routes");
    const byId = new Map(body.items.map((route) => [route.id, route]));

    expect(byId.get("callable")?.dispatchable).toBe(true);
    expect(byId.get("callable")?.sources).toEqual(["direct"]);
    expect(byId.get("scheduled")?.dispatchable).toBe(false);
    expect(byId.get("scheduled")?.sources).toEqual(["cron"]);
  });

  /**
   * @case The documented filters narrow the one collection
   * @preconditions A dispatchable and a non-dispatchable route
   * @expectedResult Unfiltered returns both, dispatchable=true returns one, an exact id returns one, and source=cron returns the cron route. One collection with query parameters, so the two clients differ in the query they send rather than the resource they address
   */
  test("narrows the collection by the documented filters", async () => {
    const port = await start({
      tiers: { introspection: true },
      routes: [
        craft().id("callable").from(direct()).to(noop()),
        craft().id("scheduled").from(cron("0 0 * * *")).to(noop()),
      ],
    });

    const all = await call<OpsPage<OpsRouteSummary>>(port, "/ops/routes");
    expect(all.body.items).toHaveLength(2);

    const dispatchable = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes?dispatchable=true",
    );
    expect(dispatchable.body.items.map((r) => r.id)).toEqual(["callable"]);

    const byId = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes?id=scheduled",
    );
    expect(byId.body.items.map((r) => r.id)).toEqual(["scheduled"]);

    const bySource = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes?source=cron",
    );
    expect(bySource.body.items.map((r) => r.id)).toEqual(["scheduled"]);
  });

  /**
   * @case A collection larger than one page is walked by cursor without loss
   * @preconditions 120 routes, more than the default page size, paged with an explicit limit
   * @expectedResult Every route appears exactly once across the pages, in order, and the last page carries no cursor. Skipping or repeating a row is the failure mode keyset paging exists to prevent, and it surfaces as missing data rather than as an error
   */
  test("pages a collection larger than one page without skipping or repeating", async () => {
    const routes = Array.from({ length: 120 }, (_unused, index) =>
      craft()
        .id(`route-${String(index).padStart(3, "0")}`)
        .from(direct())
        .to(noop()),
    );
    const port = await start({ tiers: { introspection: true }, routes });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ limit: "25" });
      if (cursor !== undefined) query.set("after", cursor);
      const page = await call<OpsPage<OpsRouteSummary>>(
        port,
        `/ops/routes?${query.toString()}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((route) => route.id));
      cursor = page.body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...seen].sort());
  });

  /**
   * @case The default page size bounds an unbounded request
   * @preconditions 120 routes, no limit given
   * @expectedResult One page of the default size, carrying a cursor. A caller that names no limit still gets a bounded page rather than the whole collection
   */
  test("bounds a request that names no limit", async () => {
    const routes = Array.from({ length: 120 }, (_unused, index) =>
      craft()
        .id(`route-${String(index).padStart(3, "0")}`)
        .from(direct())
        .to(noop()),
    );
    const port = await start({ tiers: { introspection: true }, routes });
    const { body } = await call<OpsPage<OpsRouteSummary>>(port, "/ops/routes");

    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).toBeDefined();
  });

  /**
   * @case A malformed limit is refused rather than interpreted
   * @preconditions limit values of 0, -1, 1.5 and a non-number
   * @expectedResult 400 for each. Refusing beats clamping: a caller silently handed a bounded page cannot tell a truncated answer from a complete one
   */
  test("refuses a malformed limit", async () => {
    const port = await start({ tiers: { introspection: true } });
    for (const limit of ["0", "-1", "1.5", "many"]) {
      const { status } = await call(port, `/ops/routes?limit=${limit}`);
      expect(status).toBe(400);
    }
  });

  /**
   * @case A limit beyond the server-side maximum is refused
   * @preconditions limit of 10000
   * @expectedResult 400. The maximum is what keeps a pathological request from turning into an out-of-memory event, and it is refused rather than silently reduced for the same reason as any other malformed limit
   */
  test("refuses a limit beyond the server maximum", async () => {
    const port = await start({ tiers: { introspection: true } });
    const { status } = await call(port, "/ops/routes?limit=10000");
    expect(status).toBe(400);
  });

  /**
   * @case A cursor replayed under a different filter is refused
   * @preconditions A cursor minted with no filter, replayed with dispatchable=true
   * @expectedResult 400 naming the filter change. A cursor pages one result set, so honouring it under a different filter would hand back a page of a different listing with nothing to signal it
   */
  test("refuses a cursor replayed under a different filter", async () => {
    const routes = Array.from({ length: 10 }, (_unused, index) =>
      craft()
        .id(`route-${String(index)}`)
        .from(direct())
        .to(noop()),
    );
    const port = await start({ tiers: { introspection: true }, routes });

    const first = await call<OpsPage<OpsRouteSummary>>(
      port,
      "/ops/routes?limit=2",
    );
    const cursor = first.body.nextCursor;
    expect(cursor).toBeDefined();

    const replayed = await call<{ message: string }>(
      port,
      `/ops/routes?limit=2&dispatchable=true&after=${encodeURIComponent(cursor!)}`,
    );
    expect(replayed.status).toBe(400);
    expect(replayed.body.message).toMatch(/different filter/);
  });

  /**
   * @case A garbled cursor is refused rather than read as a starting point
   * @preconditions after set to a value this API never minted
   * @expectedResult 400. Silently starting from the beginning would present a full first page as a resumed one
   */
  test("refuses a malformed cursor", async () => {
    const port = await start({ tiers: { introspection: true } });
    const { status } = await call(port, "/ops/routes?after=not-a-cursor");
    expect(status).toBe(400);
  });

  /**
   * @case One route is described with its declared schemas
   * @preconditions A route declaring .title(), .description() and .input()
   * @expectedResult 200 carrying the title, the description and a JSON Schema rendering of the input, which is what tells an operator what the route accepts without reading its source
   */
  test("describes one route with its declared metadata", async () => {
    const port = await start({
      tiers: { introspection: true },
      routes: [
        craft()
          .id("greet")
          .title("Greeter")
          .description("Says hello")
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .to(noop()),
      ],
    });
    const { status, body } = await call<OpsRouteDetail>(
      port,
      "/ops/routes/greet",
    );

    expect(status).toBe(200);
    expect(body.title).toBe("Greeter");
    expect(body.description).toBe("Says hello");
    expect(body.dispatchable).toBe(true);
    expect(body.input?.body).toBeDefined();
  });

  /**
   * @case An unknown route id answers 404 on the detail resource
   * @preconditions Introspection open, an id no route declares
   * @expectedResult 404
   */
  test("answers 404 for an unknown route id", async () => {
    const port = await start({ tiers: { introspection: true } });
    const { status } = await call(port, "/ops/routes/nope");
    expect(status).toBe(404);
  });

  /**
   * @case A dispatch returns the route's output
   * @preconditions Dispatch open, a direct route that transforms its body
   * @expectedResult 200 with outcome completed and the route's own output
   */
  test("dispatches and returns the route output", async () => {
    const port = await start({
      tiers: { dispatch: true },
      routes: [
        craft()
          .id("greet")
          .from(direct())
          .transform(
            (body) => `hello ${String((body as { name: string }).name)}`,
          )
          .to(noop()),
      ],
    });
    const { status, body } = await call<{ outcome: string; body: unknown }>(
      port,
      "/ops/routes/greet/exchanges",
      { method: "POST", body: { name: "world" } },
    );

    expect(status).toBe(200);
    expect(body.outcome).toBe("completed");
    expect(body.body).toBe("hello world");
  });

  /**
   * @case A dispatch against a route with no dispatch door is refused distinguishably
   * @preconditions Dispatch open, target route sourced from cron()
   * @expectedResult 409 carrying RC5060 and naming the route's actual sources, so the answer is "this route has no door" rather than "no such route"
   */
  test("refuses a dispatch against a non-dispatchable route", async () => {
    const port = await start({
      tiers: { dispatch: true },
      routes: [craft().id("scheduled").from(cron("0 0 * * *")).to(noop())],
    });
    const { status, body } = await call<{ code: string; message: string }>(
      port,
      "/ops/routes/scheduled/exchanges",
      { method: "POST", body: {} },
    );

    expect(status).toBe(409);
    expect(body.code).toBe("RC5060");
    expect(body.message).toMatch(/cron/);
  });

  /**
   * @case A dispatch against an unknown route answers 404
   * @preconditions Dispatch open, an id no route declares
   * @expectedResult 404, distinct from the 409 a known but non-dispatchable route answers
   */
  test("answers 404 dispatching to an unknown route", async () => {
    const port = await start({ tiers: { dispatch: true } });
    const { status } = await call(port, "/ops/routes/nope/exchanges", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(404);
  });

  /**
   * @case The dispatched exchange carries the principal the mount minted
   * @preconditions A route whose .authorize() demands a role, dispatched by a principal carrying it
   * @expectedResult 200. There is no bypass and no synthetic operator identity: the route's own pre-from chain runs and sees exactly the principal the validator produced, so an operator dispatch is indistinguishable from any other authenticated caller
   */
  test("runs the full pre-from chain with the validator-minted principal", async () => {
    const port = await start({
      auth: apiKey({
        verify: (key: string): Principal | null =>
          key === "operator"
            ? {
                kind: "custom",
                scheme: "apiKey",
                subject: "operator",
                scopes: ["ops:dispatch"],
                roles: ["admin"],
              }
            : null,
      }),
      tiers: { dispatch: "ops:dispatch" },
      routes: [
        craft()
          .id("guarded")
          .authorize({ roles: ["admin"] })
          .from(direct())
          .transform(() => "allowed")
          .to(noop()),
      ],
    });

    const { status, body } = await call<{ outcome: string; body: unknown }>(
      port,
      "/ops/routes/guarded/exchanges",
      { method: "POST", key: "operator", body: {} },
    );
    expect(status).toBe(200);
    expect(body.body).toBe("allowed");
  });

  /**
   * @case A route's own authorize refusal is reported as a dispatch failure, not a door refusal
   * @preconditions An open dispatch tier and a route demanding a role no caller carries
   * @expectedResult 500 carrying the framework's error code. The door admitted the caller and the route refused it, and collapsing the two would tell an operator to go fix their credential when the app's policy is what said no
   */
  test("reports a route-level authorize refusal separately from a tier refusal", async () => {
    const port = await start({
      tiers: { dispatch: true },
      routes: [
        craft()
          .id("guarded")
          .authorize({ roles: ["admin"] })
          .from(direct())
          .to(noop()),
      ],
    });
    const { status, body } = await call<{ error: string; code: string }>(
      port,
      "/ops/routes/guarded/exchanges",
      { method: "POST", body: {} },
    );

    expect(status).toBe(500);
    expect(body.error).toBe("dispatch failed");
    expect(body.code).toBeDefined();
  });

  /**
   * @case A parked dispatch answers with the standard Suspended acknowledgment
   * @preconditions A suspendable route, dispatch open
   * @expectedResult 202 with outcome suspended and the suspension id and token. A park is an outcome and not an error: the operator at the terminal is often exactly who the park is waiting for
   */
  test("returns the Suspended acknowledgment for a parked dispatch", async () => {
    const port = await start({
      tiers: { dispatch: true },
      suspension: true,
      routes: [
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: z.object({ approved: z.boolean() }) })
          .to(noop()),
      ],
    });

    const { status, body } = await call<{
      outcome: string;
      suspension: { status: string; suspensionId: string; token: string };
    }>(port, "/ops/routes/payout/exchanges", { method: "POST", body: {} });

    expect(status).toBe(202);
    expect(body.outcome).toBe("suspended");
    expect(body.suspension.status).toBe("suspended");
    expect(body.suspension.suspensionId).toBeTruthy();
    expect(body.suspension.token).toBeTruthy();
  });

  /**
   * @case A dropped exchange is reported as a drop, not a failure
   * @preconditions A route whose filter rejects the message, dispatch open
   * @expectedResult 200 with outcome dropped. A drop means a filter said no and there is no response body; reporting it as a failure would send an operator looking for a broken step
   */
  test("distinguishes a dropped exchange from a failure", async () => {
    const port = await start({
      tiers: { dispatch: true },
      routes: [
        craft()
          .id("picky")
          .from(direct())
          .filter(() => false)
          .to(noop()),
      ],
    });
    const { status, body } = await call<{ outcome: string }>(
      port,
      "/ops/routes/picky/exchanges",
      { method: "POST", body: {} },
    );

    expect(status).toBe(200);
    expect(body.outcome).toBe("dropped");
  });

  /**
   * @case The wrong method on an enabled resource answers 405 with Allow
   * @preconditions Introspection open, the collection requested with POST
   * @expectedResult 405 carrying Allow. A disabled tier would answer 404 instead, so the method answer never leaks that a tier exists
   */
  test("answers 405 for the wrong method on an enabled tier", async () => {
    const port = await start({ tiers: { introspection: true } });
    const { status, headers } = await call(port, "/ops/routes", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("GET, HEAD");
  });

  /**
   * @case An unknown path under a claimed prefix answers 404
   * @preconditions Both tiers open, a path this API does not define
   * @expectedResult 404. The mount claims /ops whole, so an undefined path must be answered here rather than falling through to another surface on a shared listener
   */
  test("answers 404 for an unknown management path", async () => {
    const port = await start({
      tiers: { introspection: true, dispatch: true },
    });
    const { status } = await call(port, "/ops/nothing/here");
    expect(status).toBe(404);
  });
});
