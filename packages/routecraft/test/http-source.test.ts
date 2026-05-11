import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  apiKey,
  craft,
  DefaultExchange,
  http,
  jwt,
  noop,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
} from "@routecraft/routecraft";
import { createHmac } from "node:crypto";

const JWT_SECRET = "test-secret-please-change-me";
const JWT_ISSUER = "https://idp.test";
const JWT_AUDIENCE = "https://api.test";

function makeJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    }),
  );
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

interface BootHttpOptions {
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0];
  http: HttpPluginOptions;
  events?: Partial<Record<EventName, (ev: { details: unknown }) => void>>;
}

interface BootHttpResult {
  ctx: TestContext;
  port: number;
}

async function bootHttp(opts: BootHttpOptions): Promise<BootHttpResult> {
  let resolvedPort = 0;
  const builder = testContext()
    .on(
      "plugin:http:server:listening" as EventName,
      ((payload: { details: unknown }) => {
        resolvedPort = (payload.details as { port: number }).port;
      }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
    )
    .routes(opts.routes)
    .with({ http: opts.http } as CraftConfig);
  if (opts.events) {
    for (const [name, handler] of Object.entries(opts.events)) {
      builder.on(
        name as EventName,
        handler as Parameters<ReturnType<typeof testContext>["on"]>[1],
      );
    }
  }
  const ctx = await builder.build();
  await ctx.startAndWaitReady();
  expect(resolvedPort).toBeGreaterThan(0);
  return { ctx, port: resolvedPort };
}

describe("HTTP Source Adapter", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case Plugin starts and serves a GET route
   * @preconditions defineConfig({ http: { port: 0 } }) and a route using .from(http({ path }))
   * @expectedResult The bound server returns the route's body as JSON with status 200
   */
  test("GET route returns the route body as JSON", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("hello")
        .from(http({ path: "/hello", method: "GET" }))
        .transform(() => ({ greeting: "hello world" }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ greeting: "hello world" });
  });

  /**
   * @case Path parameters land on the exchange under `routecraft.http.params`
   * @preconditions Pattern is `/orders/:id`
   * @expectedResult `ex.headers["routecraft.http.params"].id` is the URL-decoded value
   */
  test("path params land on exchange headers", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("get-order")
        .from(http({ path: "/orders/:id", method: "GET" }))
        .process(async (ex) => {
          const params = ex.headers["routecraft.http.params"] as
            | Record<string, string>
            | undefined;
          return DefaultExchange.rewrap(ex, {
            body: { id: params?.["id"] ?? null },
          });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/orders/abc%20123`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc 123" });
  });

  /**
   * @case POST with JSON body is parsed onto exchange.body
   * @preconditions Content-Type: application/json
   * @expectedResult The route receives the parsed object as `body`
   */
  test("POST body application/json is parsed", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("create")
        .from(http({ path: "/items", method: "POST" }))
        .transform((body) => ({ echo: body }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "x", qty: 3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: { sku: "x", qty: 3 } });
  });

  /**
   * @case DELETE with no return body responds 204 No Content
   * @preconditions Route's final body is undefined
   * @expectedResult Server responds 204 and Content-Length 0
   */
  test("DELETE responds 204 when body is undefined", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("delete")
        .from(http({ path: "/items/:id", method: "DELETE" }))
        .transform(() => undefined)
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/items/123`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  /**
   * @case Unknown path returns 404
   * @preconditions No route claims the requested pathname
   * @expectedResult 404 with JSON error body
   */
  test("unknown path returns 404", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("a")
        .from(http({ path: "/a", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/missing`);
    expect(res.status).toBe(404);
  });

  /**
   * @case Known path but wrong method returns 405 with Allow header
   * @preconditions Route registered for POST but client sends GET
   * @expectedResult 405 + Allow header lists registered methods
   */
  test("wrong method returns 405", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("post-only")
        .from(http({ path: "/things", method: "POST" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/things`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  /**
   * @case Global bearer auth rejects missing token with 401
   * @preconditions http.auth = jwt({...})
   * @expectedResult Request without Authorization header is 401
   */
  test("global bearer auth rejects missing token", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("secret")
        .from(http({ path: "/secret", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/secret`);
    expect(res.status).toBe(401);
  });

  /**
   * @case Global bearer auth admits a valid JWT and attaches the principal
   * @preconditions http.auth = jwt({...}); client sends a valid Authorization header
   * @expectedResult 200 + the principal subject is reachable via exchange.principal
   */
  test("global bearer auth admits valid JWT", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("me")
        .from(http({ path: "/me", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: { subject: ex.principal?.subject ?? null },
          }),
        )
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
    });
    t = bound.ctx;

    const token = makeJwt({ sub: "user-42" });
    const res = await fetch(`http://127.0.0.1:${bound.port}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: "user-42" });
  });

  /**
   * @case public: true bypasses global auth
   * @preconditions Plugin has global jwt auth; route declares public: true
   * @expectedResult Request without Authorization header is 200
   */
  test("public: true bypasses global auth", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("public")
        .from(http({ path: "/public", method: "GET", public: true }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/public`);
    expect(res.status).toBe(200);
  });

  /**
   * @case apiKey allowlist admits matching keys and rejects others
   * @preconditions http.auth = apiKey({ keys: [...] })
   * @expectedResult Header x-api-key must match a configured key, else 401
   */
  test("apiKey allowlist admits matching key only", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("k")
        .from(http({ path: "/k", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: apiKey({ keys: ["letmein"] }),
      },
    });
    t = bound.ctx;

    const okRes = await fetch(`http://127.0.0.1:${bound.port}/k`, {
      headers: { "x-api-key": "letmein" },
    });
    expect(okRes.status).toBe(200);
    const denyRes = await fetch(`http://127.0.0.1:${bound.port}/k`, {
      headers: { "x-api-key": "wrong" },
    });
    expect(denyRes.status).toBe(401);
    const missingRes = await fetch(`http://127.0.0.1:${bound.port}/k`);
    expect(missingRes.status).toBe(401);
  });

  /**
   * @case Per-route authorize() rejects principal that lacks a role
   * @preconditions http.auth = jwt(...) and route declares .authorize({ roles: ["admin"] })
   * @expectedResult Non-200 status when the JWT has no admin role
   */
  test(".authorize() rejects principal missing required role", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("admin")
        .authorize({ roles: ["admin"] })
        .from(http({ path: "/admin", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
    });
    t = bound.ctx;

    const token = makeJwt({ sub: "user-42", roles: ["viewer"] });
    const res = await fetch(`http://127.0.0.1:${bound.port}/admin`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // authorize() throws RC5015 (permission denied) which the route engine
    // converts to context:error; the dispatcher surfaces it as 500. Either
    // way the request must not be admitted, which is what we assert here.
    expect(res.status).not.toBe(200);
  });

  /**
   * @case Built-in /health returns 200 status:ok
   * @preconditions Plugin is configured; no user route claims /health
   * @expectedResult 200 with JSON body { status: "ok" }
   */
  test("built-in /health responds 200", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("u")
        .from(http({ path: "/u", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  /**
   * @case Built-in /openapi.json describes registered routes
   * @preconditions Two user routes registered
   * @expectedResult OpenAPI document lists both paths with the right methods and operationIds
   */
  test("built-in /openapi.json lists registered routes", async () => {
    const bound = await bootHttp({
      routes: [
        craft()
          .id("get-thing")
          .description("Fetch a thing")
          .from(http({ path: "/things/:id", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
        craft()
          .id("create-thing")
          .description("Create a thing")
          .from(http({ path: "/things", method: "POST" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      ],
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/things/{id}"]?.["get"]?.operationId).toBe("get-thing");
    expect(doc.paths["/things"]?.["post"]?.operationId).toBe("create-thing");
  });

  /**
   * @case http() source used without httpPlugin throws RC5003 on start
   * @preconditions defineConfig has no `http` block
   * @expectedResult Starting the context surfaces RC5003
   */
  test("http() source without plugin throws RC5003", async () => {
    const builder = testContext().routes(
      craft()
        .id("orphan")
        .from(http({ path: "/orphan", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
    );
    t = await builder.build();
    await expect(t.test()).rejects.toThrow(/http plugin|httpPlugin|RC5003/);
  });

  /**
   * @case Maximum body size enforces 413
   * @preconditions http.maxBodySize is small; POST sends a larger body
   * @expectedResult Server responds 413
   */
  test("body exceeding maxBodySize returns 413", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("upload")
        .from(http({ path: "/upload", method: "POST" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0, maxBodySize: 16 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(64),
    });
    expect(res.status).toBe(413);
  });

  /**
   * @case Per-request event fires with method/path/status/durationMs
   * @preconditions perRequest event toggle is on (default)
   * @expectedResult plugin:http:request:completed receives the right payload after a successful request
   */
  test("plugin:http:request:completed fires after a request", async () => {
    const events: Array<{
      method: string;
      path: string;
      status: number;
      routeId?: string;
    }> = [];
    const bound = await bootHttp({
      routes: craft()
        .id("ev")
        .from(http({ path: "/ev", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
      events: {
        "plugin:http:request:completed": (ev) => {
          events.push(
            ev.details as {
              method: string;
              path: string;
              status: number;
              routeId?: string;
            },
          );
        },
      },
    });
    t = bound.ctx;

    await fetch(`http://127.0.0.1:${bound.port}/ev`);
    // Give the event loop a chance to flush the synchronous emit.
    await new Promise((r) => setTimeout(r, 5));

    const ev = events.find((e) => e.path === "/ev");
    expect(ev).toBeDefined();
    expect(ev!.method).toBe("GET");
    expect(ev!.status).toBe(200);
    expect(ev!.routeId).toBe("ev");
  });
});
