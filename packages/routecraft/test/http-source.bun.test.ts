import { describe, test, expect, afterEach } from "bun:test";
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
   * @case Invalid auth mode fails fast at the http() call site
   * @preconditions Caller passes an unrecognised auth string (e.g. typo "skp")
   * @expectedResult `http({...})` throws RC5003 immediately. Catching the
   *   misconfiguration at construction (not at the first unauthenticated
   *   request) prevents a fail-open downgrade: a route the dispatcher would
   *   otherwise treat as "optional" because the value isn't exactly "required"
   *   or "skip" never gets the chance to register.
   */
  test("invalid auth mode throws RC5003 at http() call", () => {
    let err: unknown;
    try {
      http({
        path: "/bad",
        method: "GET",
        // @ts-expect-error -- testing runtime validation for untyped callers
        auth: "skp",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { rc?: string }).rc).toBe("RC5003");
    expect((err as Error).message).toContain("invalid auth mode");
  });

  /**
   * @case auth: "skip" bypasses global auth completely
   * @preconditions Plugin has global jwt auth; route declares auth: "skip"
   * @expectedResult Request without Authorization header is 200 and no
   *   auth:* events are emitted (skip means no auth was attempted)
   */
  test('auth: "skip" bypasses global auth', async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("public")
        .from(http({ path: "/public", method: "GET", auth: "skip" }))
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
      events: {
        "auth:success": () => authEvents.push("success"),
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/public`);
    expect(res.status).toBe(200);
    expect(authEvents).toEqual([]);
  });

  /**
   * @case auth: "optional" admits anonymously when no credential is present
   * @preconditions Plugin has global jwt auth; route declares auth: "optional"
   * @expectedResult Request without Authorization header is 200 with no
   *   principal on the exchange; no auth:* events fire because no auth was
   *   attempted
   */
  test('auth: "optional" admits anonymous without principal', async () => {
    const authEvents: string[] = [];
    let observedSubject: string | undefined = "untouched";
    const bound = await bootHttp({
      routes: craft()
        .id("optional")
        .from(http({ path: "/me", method: "GET", auth: "optional" }))
        .process(async (ex) => {
          observedSubject = ex.principal?.subject;
          return DefaultExchange.rewrap(ex, {
            body: { subject: observedSubject ?? null },
          });
        })
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
      events: {
        "auth:success": () => authEvents.push("success"),
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: null });
    expect(observedSubject).toBeUndefined();
    expect(authEvents).toEqual([]);
  });

  /**
   * @case auth: "optional" attaches principal when a valid credential is present
   * @preconditions Plugin has global jwt auth; route declares auth: "optional"
   * @expectedResult Request with a valid bearer token is 200 and the
   *   exchange carries the verified principal; auth:success fires
   */
  test('auth: "optional" attaches principal when token is valid', async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("optional-valid")
        .from(http({ path: "/me", method: "GET", auth: "optional" }))
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
      events: {
        "auth:success": () => authEvents.push("success"),
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const token = makeJwt({ sub: "user-7" });
    const res = await fetch(`http://127.0.0.1:${bound.port}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: "user-7" });
    expect(authEvents).toEqual(["success"]);
  });

  /**
   * @case auth: "optional" still rejects an invalid credential
   * @preconditions Plugin has global jwt auth; route declares auth: "optional";
   *   client sends a malformed/expired/forged Bearer token
   * @expectedResult Request is 401 and auth:rejected fires. "Optional" means
   *   "do not require auth"; it does not mean "accept anything you send".
   */
  test('auth: "optional" rejects invalid credential', async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("optional-bad")
        .from(http({ path: "/me", method: "GET", auth: "optional" }))
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
      events: {
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/me`, {
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
    expect(authEvents).toEqual(["rejected"]);
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
    // emit() is synchronous and the dispatcher fires the per-request event
    // before returning the response, so the fetch's await is enough.

    const ev = events.find((e) => e.path === "/ev");
    expect(ev).toBeDefined();
    expect(ev!.method).toBe("GET");
    expect(ev!.status).toBe(200);
    expect(ev!.routeId).toBe("ev");
  });

  /**
   * @case auth:success / auth:rejected fire with the framework's documented payload shape
   * @preconditions Global jwt auth; one valid request and one unauthenticated request
   * @expectedResult auth:success carries { subject, scheme, source }; auth:rejected carries { reason, scheme, source }
   */
  test("auth events use the documented { subject|reason, scheme, source } shape", async () => {
    const success: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    const bound = await bootHttp({
      routes: craft()
        .id("ev-auth")
        .from(http({ path: "/ev-auth", method: "GET" }))
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
      events: {
        "auth:success": (ev) =>
          success.push(ev.details as Record<string, unknown>),
        "auth:rejected": (ev) =>
          rejected.push(ev.details as Record<string, unknown>),
      },
    });
    t = bound.ctx;

    await fetch(`http://127.0.0.1:${bound.port}/ev-auth`, {
      headers: { authorization: `Bearer ${makeJwt({ sub: "user-7" })}` },
    });
    await fetch(`http://127.0.0.1:${bound.port}/ev-auth`); // no token -> rejected
    // emit() is synchronous; both fetches resolve after auth:* events fired.

    expect(success[0]).toEqual({
      subject: "user-7",
      scheme: "bearer",
      source: "http",
    });
    expect(rejected[0]).toEqual({
      reason: "missing bearer token",
      scheme: "bearer",
      source: "http",
    });
  });

  /**
   * @case apiKey auth can read the key from a query parameter
   * @preconditions http.auth = apiKey({ in: "query", name: "api_key", keys: [...] })
   * @expectedResult Matching query key admits (200); wrong/missing key rejects (401)
   */
  test("apiKey query-mode admits matching key only", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("kq")
        .from(http({ path: "/kq", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: apiKey({ in: "query", name: "api_key", keys: ["secret"] }),
      },
    });
    t = bound.ctx;

    const ok = await fetch(`http://127.0.0.1:${bound.port}/kq?api_key=secret`);
    expect(ok.status).toBe(200);
    const wrong = await fetch(`http://127.0.0.1:${bound.port}/kq?api_key=nope`);
    expect(wrong.status).toBe(401);
    const missing = await fetch(`http://127.0.0.1:${bound.port}/kq`);
    expect(missing.status).toBe(401);
  });

  /**
   * @case Binding a second server to an in-use port fails to start
   * @preconditions One server already bound to a port; a second context targets the same port
   * @expectedResult The second context's start rejects (RC5019 bind failure) rather than silently running
   */
  test("port already in use surfaces a bind failure", async () => {
    const first = await bootHttp({
      routes: craft()
        .id("first")
        .from(http({ path: "/first", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = first.ctx;

    const second = await testContext()
      .routes(
        craft()
          .id("second")
          .from(http({ path: "/second", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .with({ http: { port: first.port } } as CraftConfig);

    await expect(second.build()).rejects.toThrow(
      /bind failed|RC5019|EADDRINUSE/i,
    );
  });
});

describe("HTTP Source Adapter -- Auth coverage", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case Bearer auth rejects an Authorization header that is not "Bearer ..."
   * @preconditions Global jwt() auth; client sends `Authorization: Basic ...`
   * @expectedResult 401 with WWW-Authenticate header
   */
  test("bearer auth rejects non-Bearer authorization scheme", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("scheme")
        .from(http({ path: "/scheme", method: "GET" }))
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

    const res = await fetch(`http://127.0.0.1:${bound.port}/scheme`, {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  /**
   * @case Bearer auth rejects a token whose signature is wrong
   * @preconditions Token signed with a different secret
   * @expectedResult 401
   */
  test("bearer auth rejects token with bad signature", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("sig")
        .from(http({ path: "/sig", method: "GET" }))
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

    // Build a token signed with a different secret, otherwise valid.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: "user-x",
      }),
    ).toString("base64url");
    const badSig = createHmac("sha256", "different-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");
    const badToken = `${header}.${payload}.${badSig}`;

    const res = await fetch(`http://127.0.0.1:${bound.port}/sig`, {
      headers: { authorization: `Bearer ${badToken}` },
    });
    expect(res.status).toBe(401);
  });

  /**
   * @case Bearer auth rejects a JWT with the wrong issuer
   * @preconditions Token issuer differs from configured issuer
   * @expectedResult 401
   */
  test("bearer auth rejects token with wrong issuer", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("iss")
        .from(http({ path: "/iss", method: "GET" }))
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

    // Manually mint a token with a different `iss`.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://other-idp.test",
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: "user-y",
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const token = `${header}.${payload}.${sig}`;

    const res = await fetch(`http://127.0.0.1:${bound.port}/iss`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  /**
   * @case Bearer auth rejects an expired JWT
   * @preconditions Token exp is in the past
   * @expectedResult 401
   */
  test("bearer auth rejects expired token", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("exp")
        .from(http({ path: "/exp", method: "GET" }))
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

    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) - 60, // expired one minute ago
        sub: "user-z",
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const token = `${header}.${payload}.${sig}`;

    const res = await fetch(`http://127.0.0.1:${bound.port}/exp`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  /**
   * @case Custom { validator } admits the request when verifier returns a Principal
   * @preconditions Validator returns a synthetic Principal; client sends matching token
   * @expectedResult 200 and downstream sees the principal
   */
  test("custom validator admits and attaches the principal", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("validator-ok")
        .from(http({ path: "/v", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: { subject: ex.principal?.subject },
          }),
        )
        .to(noop()),
      http: {
        port: 0,
        auth: {
          validator: async (token: string) => {
            if (token !== "magic") throw new Error("nope");
            return { kind: "custom", scheme: "bearer", subject: "alice" };
          },
        },
      },
    });
    t = bound.ctx;

    const okRes = await fetch(`http://127.0.0.1:${bound.port}/v`, {
      headers: { authorization: "Bearer magic" },
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ subject: "alice" });

    const denyRes = await fetch(`http://127.0.0.1:${bound.port}/v`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(denyRes.status).toBe(401);
  });

  /**
   * @case apiKey verify() admits when the verifier returns a Principal; rejects when null
   * @preconditions auth.verify(key) returns Principal for "secret", null otherwise
   * @expectedResult 200 for matching key, 401 otherwise; principal is the verifier's return value
   */
  test("apiKey verify() function admits or rejects per its return", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("kv")
        .from(http({ path: "/kv", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: {
              subject: ex.principal?.subject,
              roles: ex.principal?.roles ?? [],
            },
          }),
        )
        .to(noop()),
      http: {
        port: 0,
        auth: apiKey({
          verify: (k) =>
            k === "secret"
              ? {
                  kind: "custom",
                  scheme: "apiKey",
                  subject: "user-42",
                  roles: ["reader"],
                }
              : null,
        }),
      },
    });
    t = bound.ctx;

    const ok = await fetch(`http://127.0.0.1:${bound.port}/kv`, {
      headers: { "x-api-key": "secret" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ subject: "user-42", roles: ["reader"] });

    const deny = await fetch(`http://127.0.0.1:${bound.port}/kv`, {
      headers: { "x-api-key": "nope" },
    });
    expect(deny.status).toBe(401);
  });

  /**
   * @case apiKey reads from a custom header name (case-insensitive)
   * @preconditions auth.name = "x-tenant-key"; client sends matching header (with mixed casing)
   * @expectedResult 200 (header lookup is case-insensitive)
   */
  test("apiKey custom header name is matched case-insensitively", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("kn")
        .from(http({ path: "/kn", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: apiKey({ name: "X-Tenant-Key", keys: ["letmein"] }),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/kn`, {
      headers: { "x-tenant-key": "letmein" }, // lower-case
    });
    expect(res.status).toBe(200);
  });

  /**
   * @case .authorize({ scopes }) admits when the principal has every required scope
   * @preconditions JWT carries scope claim "orders.write orders.read"
   * @expectedResult 200 when scopes match; 403-ish (non-200) when missing
   */
  test(".authorize({ scopes }) gates on principal scopes", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("scopes")
        .authorize({ scopes: ["orders.write"] })
        .from(http({ path: "/scopes", method: "GET" }))
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

    const grant = makeJwt({ sub: "u1", scope: "orders.read orders.write" });
    const ok = await fetch(`http://127.0.0.1:${bound.port}/scopes`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    expect(ok.status).toBe(200);

    const deny = makeJwt({ sub: "u1", scope: "orders.read" });
    const denyRes = await fetch(`http://127.0.0.1:${bound.port}/scopes`, {
      headers: { authorization: `Bearer ${deny}` },
    });
    expect(denyRes.status).not.toBe(200);
  });

  /**
   * @case .authorize({ predicate }) custom check runs against the principal
   * @preconditions Predicate accepts only principals whose subject starts with "svc-"
   * @expectedResult 200 for matching subject; non-200 otherwise
   */
  test(".authorize({ predicate }) runs the custom check", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("pred")
        .authorize({ predicate: (p) => p.subject.startsWith("svc-") })
        .from(http({ path: "/pred", method: "GET" }))
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

    const okToken = makeJwt({ sub: "svc-payments" });
    const ok = await fetch(`http://127.0.0.1:${bound.port}/pred`, {
      headers: { authorization: `Bearer ${okToken}` },
    });
    expect(ok.status).toBe(200);

    const denyToken = makeJwt({ sub: "user-1" });
    const deny = await fetch(`http://127.0.0.1:${bound.port}/pred`, {
      headers: { authorization: `Bearer ${denyToken}` },
    });
    expect(deny.status).not.toBe(200);
  });
});

describe("HTTP Source Adapter -- request/response coverage", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case Query parameters land on exchange under routecraft.http.query
   * @preconditions GET /q?x=1&y=two
   * @expectedResult routecraft.http.query is { x: "1", y: "two" }
   */
  test("query params land on exchange headers", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("q")
        .from(http({ path: "/q", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: ex.headers["routecraft.http.query"] as Record<string, string>,
          }),
        )
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/q?x=1&y=two`);
    expect(await res.json()).toEqual({ x: "1", y: "two" });
  });

  /**
   * @case Request headers land on exchange under routecraft.http.headers (lower-cased)
   * @preconditions Client sends a custom X-Trace header
   * @expectedResult routecraft.http.headers["x-trace"] === "abc"
   */
  test("request headers land on exchange headers (lower-cased)", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("h")
        .from(http({ path: "/h", method: "GET" }))
        .process(async (ex) => {
          const h = ex.headers["routecraft.http.headers"] as Record<
            string,
            string
          >;
          return DefaultExchange.rewrap(ex, { body: { trace: h["x-trace"] } });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/h`, {
      headers: { "X-Trace": "abc" },
    });
    expect(await res.json()).toEqual({ trace: "abc" });
  });

  /**
   * @case Form url-encoded body is parsed into an object
   * @preconditions Content-Type: application/x-www-form-urlencoded
   * @expectedResult exchange.body is the parsed key/value object
   */
  test("application/x-www-form-urlencoded body is parsed", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("form")
        .from(http({ path: "/form", method: "POST" }))
        .transform((body) => body)
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "alice", role: "admin" }).toString(),
    });
    expect(await res.json()).toEqual({ name: "alice", role: "admin" });
  });

  /**
   * @case multipart/form-data uploads land on exchange as FormData with File entries
   * @preconditions Client posts a small text file inside a multipart form
   * @expectedResult The route reads the field name and the file's text content
   */
  test("multipart/form-data is parsed into FormData", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("mp")
        .from(http({ path: "/mp", method: "POST" }))
        .process(async (ex) => {
          const fd = ex.body as FormData;
          const file = fd.get("upload") as File;
          return DefaultExchange.rewrap(ex, {
            body: {
              name: fd.get("name"),
              fileName: file.name,
              text: await file.text(),
            },
          });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const fd = new FormData();
    fd.set("name", "alice");
    fd.set(
      "upload",
      new File(["hello world"], "greeting.txt", { type: "text/plain" }),
    );
    const res = await fetch(`http://127.0.0.1:${bound.port}/mp`, {
      method: "POST",
      body: fd,
    });
    expect(await res.json()).toEqual({
      name: "alice",
      fileName: "greeting.txt",
      text: "hello world",
    });
  });

  /**
   * @case text/* request body is exposed as a string
   * @preconditions Content-Type: text/plain
   * @expectedResult exchange.body is the raw string
   */
  test("text/plain body is parsed as a string", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("text")
        .from(http({ path: "/text", method: "POST" }))
        .transform((body) => ({ echo: body }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/text`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(await res.json()).toEqual({ echo: "hello" });
  });

  /**
   * @case String response body is sent as text/plain
   * @preconditions Final exchange body is a string
   * @expectedResult Content-Type starts with text/plain, body is the string
   */
  test("string response is served as text/plain", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("ts")
        .from(http({ path: "/ts", method: "GET" }))
        .transform(() => "plain text")
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("plain text");
  });

  /**
   * @case Uint8Array response body is sent as application/octet-stream
   * @preconditions Final exchange body is a Uint8Array
   * @expectedResult Content-Type is application/octet-stream and bytes round-trip
   */
  test("Uint8Array response is served as application/octet-stream", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const bound = await bootHttp({
      routes: craft()
        .id("bin")
        .from(http({ path: "/bin", method: "GET" }))
        .transform(() => bytes)
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(
      /application\/octet-stream/,
    );
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  /**
   * @case Response status, content-type, and extra headers can be overridden via exchange headers
   * @preconditions Process step sets routecraft.http.response.{status,contentType,headers}
   * @expectedResult The response uses the overridden status, content-type and includes the extra header
   */
  test("response hint headers override status/contentType/extra headers", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("hint")
        .from(http({ path: "/hint", method: "POST" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: { id: "abc" },
            headers: {
              ...ex.headers,
              "routecraft.http.response.status": 201,
              "routecraft.http.response.contentType":
                "application/vnd.api+json",
              "routecraft.http.response.headers": { location: "/things/abc" },
            },
          }),
        )
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/vnd.api+json");
    expect(res.headers.get("location")).toBe("/things/abc");
  });

  /**
   * @case A user route can override a built-in by claiming the same path
   * @preconditions A user route registered at GET /health
   * @expectedResult The user route runs, the built-in fallback does not
   */
  test("user route at /health overrides the built-in", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("custom-health")
        .from(http({ path: "/health", method: "GET" }))
        .transform(() => ({ status: "custom", uptime: 42 }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "custom", uptime: 42 });
  });

  /**
   * @case Built-in /ready responds 200 with a routes count
   * @preconditions One user route registered
   * @expectedResult 200, body shape { status: "ready", routes: 1 }
   */
  test("built-in /ready responds 200 with route count", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("only-one")
        .from(http({ path: "/only-one", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; routes: number };
    expect(body.status).toBe("ready");
    expect(body.routes).toBeGreaterThanOrEqual(1);
  });

  /**
   * @case Multiple routes share one HTTP server and respond independently
   * @preconditions Two routes on different paths/methods
   * @expectedResult Each route handles its own requests; cross-path traffic gets 404
   */
  test("multiple routes share the same server", async () => {
    const bound = await bootHttp({
      routes: [
        craft()
          .id("a")
          .from(http({ path: "/a", method: "GET" }))
          .transform(() => ({ from: "a" }))
          .to(noop()),
        craft()
          .id("b")
          .from(http({ path: "/b", method: "POST" }))
          .transform(() => ({ from: "b" }))
          .to(noop()),
      ],
      http: { port: 0 },
    });
    t = bound.ctx;

    const a = await fetch(`http://127.0.0.1:${bound.port}/a`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ from: "a" });

    const b = await fetch(`http://127.0.0.1:${bound.port}/b`, {
      method: "POST",
    });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ from: "b" });

    const missing = await fetch(`http://127.0.0.1:${bound.port}/c`);
    expect(missing.status).toBe(404);
  });
});

describe("HTTP Source Adapter -- /openapi.json exposure", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case openapi default (requireAuth=false) serves /openapi.json without auth even when bearer is configured
   * @preconditions http.auth = jwt(...); no builtins.openapi override
   * @expectedResult /openapi.json returns 200 without a bearer token
   */
  test("openapi default is public, even under bearer auth", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("oapi-public")
        .from(http({ path: "/oapi-public", method: "GET" }))
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

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string };
    expect(doc.openapi).toBe("3.1.0");
  });

  /**
   * @case builtins.openapi.requireAuth = true gates /openapi.json behind the global auth check
   * @preconditions http.auth = jwt(...), builtins.openapi.requireAuth = true
   * @expectedResult /openapi.json is 401 without a token, 200 with a valid one
   */
  test("openapi requireAuth gates the spec behind auth", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("oapi-auth")
        .from(http({ path: "/oapi-auth", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        builtins: { openapi: { requireAuth: true } },
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      },
    });
    t = bound.ctx;

    const deny = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(deny.status).toBe(401);

    const token = makeJwt({ sub: "u1" });
    const ok = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  /**
   * @case builtins.openapi.enabled = false returns 404 for /openapi.json
   * @preconditions builtins.openapi.enabled = false
   * @expectedResult /openapi.json returns 404
   */
  test("openapi enabled=false returns 404", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("oapi-off")
        .from(http({ path: "/oapi-off", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0, builtins: { openapi: { enabled: false } } },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(404);
  });

  /**
   * @case /ready default redacts the routes count for anonymous callers when auth is configured
   * @preconditions http.auth = jwt(...); no explicit builtins.ready config
   * @expectedResult Anonymous GET /ready returns 200 { status: "ready" } (no routes count).
   *   An authenticated caller additionally sees the routes count. Matches Spring
   *   Actuator's "show-details: when-authorized" default for /actuator/health.
   */
  test("ready default redacts routes count for anonymous callers", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("r1")
        .from(http({ path: "/r1", method: "GET" }))
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

    const anon = await fetch(`http://127.0.0.1:${bound.port}/ready`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ status: "ready" });

    const token = makeJwt({ sub: "u1" });
    const authed = await fetch(`http://127.0.0.1:${bound.port}/ready`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ status: "ready", routes: 1 });
  });

  /**
   * @case builtins.ready.requireAuth = false serves the full body to anyone
   * @preconditions http.auth = jwt(...); builtins.ready.requireAuth = false
   * @expectedResult Anonymous GET /ready returns 200 { status: "ready", routes: N }
   */
  test("ready requireAuth=false serves full body to anyone", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("r1")
        .from(http({ path: "/r1", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: jwt({
          secret: JWT_SECRET,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
        builtins: { ready: { requireAuth: false } },
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", routes: 1 });
  });

  /**
   * @case builtins.health.enabled = false returns 404 for /health
   * @preconditions builtins.health.enabled = false
   * @expectedResult GET /health returns 404
   */
  test("health enabled=false returns 404", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("h1")
        .from(http({ path: "/h1", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0, builtins: { health: { enabled: false } } },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/health`);
    expect(res.status).toBe(404);
  });
});

describe("HTTP Source Adapter -- regression: auth hardening", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case apiKey factory rejects an empty allowlist + verifier-less config at construction time
   * @preconditions apiKey({ keys: [] }) called directly
   * @expectedResult Throws RC5003 instead of producing a middleware that silently 401s everything
   */
  test("apiKey({ keys: [] }) throws RC5003 at construction", () => {
    expect(() => apiKey({ keys: [] })).toThrow(/non-empty `keys` allowlist/);
  });

  /**
   * @case apiKey factory rejects an empty-string `name`
   * @preconditions apiKey({ name: "", keys: ["x"] })
   * @expectedResult Throws RC5003
   */
  test("apiKey({ name: '' }) throws RC5003", () => {
    expect(() => apiKey({ name: "", keys: ["x"] })).toThrow(/empty `name`/);
  });

  /**
   * @case bearer rejection sends WWW-Authenticate; api-key rejection does not advertise Bearer
   * @preconditions Two contexts, one with jwt auth, one with apiKey auth
   * @expectedResult bearer 401 includes `WWW-Authenticate: Bearer ...`; apiKey 401 omits the header
   */
  test("WWW-Authenticate is scheme-aware", async () => {
    // Bearer side
    const bearer = await bootHttp({
      routes: craft()
        .id("bw")
        .from(http({ path: "/bw", method: "GET" }))
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
    t = bearer.ctx;
    const bres = await fetch(`http://127.0.0.1:${bearer.port}/bw`);
    expect(bres.status).toBe(401);
    expect(bres.headers.get("www-authenticate")).toMatch(/Bearer/);
    await t.stop();
    t = undefined;

    // ApiKey side
    const key = await bootHttp({
      routes: craft()
        .id("kw")
        .from(http({ path: "/kw", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0, auth: apiKey({ keys: ["letmein"] }) },
    });
    t = key.ctx;
    const kres = await fetch(`http://127.0.0.1:${key.port}/kw`);
    expect(kres.status).toBe(401);
    // Misleading `Bearer` challenge must not be advertised for an api-key boundary.
    expect(kres.headers.get("www-authenticate")).toBeNull();
  });

  /**
   * @case apiKey static-key principal subject is a SHA-256-derived fingerprint, not a substring of the key
   * @preconditions apiKey({ keys: ["short"] }); make an admitted request and read the principal
   * @expectedResult principal.subject begins with `apiKey:` and does not contain the raw key
   */
  test("apiKey principal subject is a SHA-256 fingerprint", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("fp")
        .from(http({ path: "/fp", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: { subject: ex.principal?.subject },
          }),
        )
        .to(noop()),
      http: { port: 0, auth: apiKey({ keys: ["short"] }) },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/fp`, {
      headers: { "x-api-key": "short" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string };
    expect(body.subject.startsWith("apiKey:")).toBe(true);
    // The raw key must not appear in the subject (the old substring approach
    // leaked it for keys shorter than 8 chars).
    expect(body.subject).not.toContain("short");
    // 16-hex-char digest after the `apiKey:` prefix.
    expect(body.subject).toMatch(/^apiKey:[0-9a-f]{16}$/);
  });
});
