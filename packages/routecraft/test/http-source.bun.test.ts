import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  apiKey,
  craft,
  DefaultExchange,
  http,
  httpPlugin,
  jwt,
  noop,
  normalizeStaticPathPrefix,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
  type ValidatorAuthOptions,
} from "@routecraft/routecraft";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  http: HttpPluginOptions & { port: number; host?: string };
  /** Server-level validator (servers.default.auth), inherited by mounts. */
  serverAuth?: ValidatorAuthOptions;
  events?: Partial<Record<EventName, (ev: { details: unknown }) => void>>;
}

interface BootHttpResult {
  ctx: TestContext;
  port: number;
}

async function bootHttp(opts: BootHttpOptions): Promise<BootHttpResult> {
  let resolvedPort = 0;
  const { port, host, ...httpOptions } = opts.http;
  const builder = testContext()
    .on(
      "server:listening" as EventName,
      ((payload: { details: unknown }) => {
        resolvedPort = (payload.details as { port: number }).port;
      }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
    )
    .routes(opts.routes)
    .with({
      servers: {
        default: {
          port,
          ...(host !== undefined ? { host } : {}),
          ...(opts.serverAuth !== undefined ? { auth: opts.serverAuth } : {}),
        },
      },
      http: httpOptions,
    } as CraftConfig);
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
            Record<string, string> | undefined;
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
   * @case The removed per-route auth option fails fast at the http() call site
   * @preconditions Untyped caller still passes the removed `auth: "skip"` option
   * @expectedResult `http({...})` throws RC5003 immediately with the migration
   *   message. Catching it at construction (not at the first request) matters
   *   because the option no longer weakens anything: silently ignoring it
   *   would leave a route the author believes is credential-exempt sitting on
   *   a walled mount answering 401s.
   */
  test("removed per-route auth option throws RC5003 at http() call", () => {
    let err: unknown;
    try {
      // The removed option makes overload resolution fail at the call
      // site, so the directive must sit on the call, not the property.
      // @ts-expect-error -- testing runtime validation for untyped callers
      http({
        path: "/bad",
        method: "GET",
        auth: "skip",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { rc?: string }).rc).toBe("RC5003");
    expect((err as Error).message).toContain("per-route `auth` was removed");
  });

  /**
   * @case The mount decides authentication: walled api, public default
   * @preconditions mounts { api: jwt wall, default: auth false }; one route each
   * @expectedResult The public route serves 200 with a garbage bearer and no
   *   auth events; the api route 401s without a token
   */
  test("walled and public mounts coexist on one listener", async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: [
        craft()
          .id("public")
          .from(http({ path: "/index", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
        craft()
          .id("orders")
          .from(http({ mount: "api", path: "/orders", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      ],
      http: {
        port: 0,
        mounts: {
          api: {
            path: "/api",
            auth: jwt({
              secret: JWT_SECRET,
              issuer: JWT_ISSUER,
              audience: JWT_AUDIENCE,
            }),
          },
          default: { path: "/", auth: false },
        },
      },
      events: {
        "auth:success": (ev) =>
          authEvents.push(
            `success:${(ev.details as { source: string }).source}`,
          ),
        "auth:rejected": (ev) =>
          authEvents.push(
            `rejected:${(ev.details as { source: string }).source}`,
          ),
      },
    });
    t = bound.ctx;

    const publicRes = await fetch(`http://127.0.0.1:${bound.port}/index`, {
      headers: { authorization: "Bearer garbage-never-inspected" },
    });
    expect(publicRes.status).toBe(200);
    expect(authEvents).toEqual([]);

    // Every rejection path on a named mount reports the same source id.
    const walledRes = await fetch(`http://127.0.0.1:${bound.port}/api/orders`);
    expect(walledRes.status).toBe(401);
    expect(authEvents).toEqual(["rejected:http:api"]);

    const token = makeJwt({ sub: "user-1" });
    const okRes = await fetch(`http://127.0.0.1:${bound.port}/api/orders`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(okRes.status).toBe(200);
    expect(authEvents).toEqual(["rejected:http:api", "success:http:api"]);
  });

  /**
   * @case Mount paths must be static canonical pathname prefixes
   * @preconditions Mount definitions carrying a query, fragment, param
   *   segment, empty segment, backslash, dot segment (raw or encoded),
   *   percent-encoding, a raw space, a bare "//", or a non-string value
   * @expectedResult httpPlugin construction fails with RC5003 for each
   */
  test("mount paths reject non-static prefixes at construction", () => {
    for (const path of [
      "/api?v=1",
      "/api#internal",
      "/api/:tenant",
      "//api",
      "/api/../admin",
      "/api/./admin",
      "/api\\admin",
      "/%2e%2e/admin",
      "/api /v1",
      "/api//",
      "/api%41",
      "//",
      1n as unknown as string,
    ]) {
      let err: unknown;
      try {
        httpPlugin({ mounts: { api: { path } } });
      } catch (e) {
        err = e;
      }
      // The path rides along in the assertion so a failure names the value
      // that stopped throwing.
      expect({ path, rc: (err as { rc?: string } | undefined)?.rc }).toEqual({
        path,
        rc: "RC5003",
      });
    }
  });

  /**
   * @case normalizeStaticPathPrefix returns the canonical form directly
   * @preconditions Valid inputs: a trailing-slash prefix, the bare root, and a colon-in-segment path
   * @expectedResult "/api/" normalises to "/api", "/" and "/api:v1" pass through unchanged
   */
  test("normalizeStaticPathPrefix normalises valid prefixes", () => {
    expect(normalizeStaticPathPrefix("/api/", "test")).toBe("/api");
    expect(normalizeStaticPathPrefix("/", "test")).toBe("/");
    expect(normalizeStaticPathPrefix("/api:v1", "test")).toBe("/api:v1");
  });

  /**
   * @case A literal colon inside a segment is a valid static prefix
   * @preconditions Mount at "/api:v1", a legal pathname the URL parser preserves; only a segment STARTING with ":" is the dynamic :param shape
   * @expectedResult httpPlugin construction succeeds
   */
  test("mount paths allow a literal colon inside a segment", () => {
    expect(() =>
      httpPlugin({ mounts: { api: { path: "/api:v1" } } }),
    ).not.toThrow();
  });

  /**
   * @case .authorize() on a public mount forces verification: absent is 401
   * @preconditions Public mount (auth false) with the jwt validator on the
   *   server; route declares a route-entry .authorize()
   * @expectedResult Request without Authorization header is 401 with
   *   auth:rejected, not admitted anonymously
   */
  test("authorize-pull on a public mount rejects a missing credential", async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("account")
        .authorize({})
        .from(http({ path: "/account", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: false,
      },
      serverAuth: jwt({
        secret: JWT_SECRET,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }),
      events: {
        "auth:success": () => authEvents.push("success"),
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/account`);
    expect(res.status).toBe(401);
    expect(authEvents).toEqual(["rejected"]);
  });

  /**
   * @case .authorize() on a public mount admits a valid credential
   * @preconditions Public mount (auth false) with the jwt validator on the
   *   server; route declares a route-entry .authorize()
   * @expectedResult A valid bearer is verified through the server validator,
   *   the exchange carries the principal, and auth:success fires
   */
  test("authorize-pull verifies a valid token through the server validator", async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("account-valid")
        .authorize({})
        .from(http({ path: "/account", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            body: { subject: ex.principal?.subject ?? null },
          }),
        )
        .to(noop()),
      http: {
        port: 0,
        auth: false,
      },
      serverAuth: jwt({
        secret: JWT_SECRET,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }),
      events: {
        "auth:success": () => authEvents.push("success"),
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const token = makeJwt({ sub: "user-7" });
    const res = await fetch(`http://127.0.0.1:${bound.port}/account`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: "user-7" });
    expect(authEvents).toEqual(["success"]);
  });

  /**
   * @case .authorize() on a public mount still rejects an invalid credential
   * @preconditions Public mount with server validator; route declares .authorize();
   *   client sends a malformed/expired/forged Bearer token
   * @expectedResult Request is 401 and auth:rejected fires. A presented
   *   credential that fails verification is a hard error, never anonymous.
   */
  test("authorize-pull rejects an invalid credential", async () => {
    const authEvents: string[] = [];
    const bound = await bootHttp({
      routes: craft()
        .id("account-bad")
        .authorize({})
        .from(http({ path: "/account", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        auth: false,
      },
      serverAuth: jwt({
        secret: JWT_SECRET,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }),
      events: {
        "auth:rejected": () => authEvents.push("rejected"),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/account`, {
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
    expect(authEvents).toEqual(["rejected"]);
  });

  /**
   * @case .authorize() with no validator anywhere refuses at bind
   * @preconditions Open server (no servers auth), public http (auth false);
   *   a route declares a route-entry .authorize()
   * @expectedResult Context start fails with RC5003 naming the route and the
   *   missing validator instead of 401ing every request forever
   */
  test("authorize route with no validator in scope fails at bind", async () => {
    const ctx = await testContext()
      .routes(
        craft()
          .id("dead-route")
          .authorize({})
          .from(http({ path: "/dead", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .with({
        servers: { default: { port: 0 } },
        http: { auth: false },
      } as CraftConfig)
      .build();
    t = ctx;

    let err: unknown;
    try {
      await ctx.ctx.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { rc?: string }).rc).toBe("RC5003");
    expect((err as Error).message).toContain("no validator is in scope");
  });

  /**
   * @case Omitted mount resolves only to a mount literally named "default"
   * @preconditions mounts declares only "api"; a route omits `mount`
   * @expectedResult Context start fails with RC5003 listing the configured
   *   mounts instead of silently landing the route on any surface
   */
  test("omitted mount with no default mount fails loudly", async () => {
    const errors: string[] = [];
    const ctx = await testContext()
      .on(
        "context:error" as EventName,
        ((payload: { details: { error: unknown } }) => {
          errors.push(String((payload.details.error as Error).message));
        }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
      )
      .routes(
        craft()
          .id("lost-route")
          .from(http({ path: "/orders", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .with({
        servers: { default: { port: 0 } },
        http: { mounts: { api: { path: "/api" } } },
      } as CraftConfig)
      .build();
    t = ctx;

    let err: unknown;
    try {
      await ctx.startAndWaitReady();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toContain('no mount named "default"');
    expect((err as Error).message).toContain('"api"');
    expect(errors.length).toBeGreaterThan(0);
  });

  /**
   * @case A public route cannot be carved out under a walled mount's prefix
   * @preconditions api mount at /api; a default-mount route declares a path
   *   that resolves inside /api
   * @expectedResult Bind-time validation refuses the cross-mount conflict
   */
  test("a route under another mount's prefix fails at bind", async () => {
    const ctx = await testContext()
      .routes(
        craft()
          .id("carved")
          .from(http({ path: "/api/webhooks", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .with({
        servers: { default: { port: 0 } },
        http: {
          mounts: {
            api: { path: "/api" },
            default: { path: "/", auth: false },
          },
        },
      } as CraftConfig)
      .build();
    t = ctx;

    let err: unknown;
    try {
      await ctx.ctx.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toContain("conflicts");
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
      reason: "missing_header",
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
      .with({
        servers: { default: { port: first.port } },
        http: {},
      } as CraftConfig);

    const secondContext = await second.build();
    await expect(secondContext.ctx.start()).rejects.toThrow(
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
   * @case Request headers land on exchange under routecraft.http.rawHeaders (lower-cased)
   * @preconditions Client sends a custom X-Trace header
   * @expectedResult routecraft.http.rawHeaders["x-trace"] === "abc"
   */
  test("request headers land on exchange headers (lower-cased)", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("h")
        .from(http({ path: "/h", method: "GET" }))
        .process(async (ex) => {
          const h = ex.headers["routecraft.http.rawHeaders"] as Record<
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
   * Boot an http context with cwd switched into a tmpdir holding the given
   * package.json, restoring cwd and removing the tmpdir before returning.
   * findPackageInfo reads cwd synchronously at plugin construction, so the
   * switch only needs to cover the boot.
   */
  async function bootHttpFromTmpPackage(
    manifest: Record<string, unknown>,
    options: Parameters<typeof bootHttp>[0],
  ): Promise<BootHttpResult> {
    const dir = mkdtempSync(join(tmpdir(), "rc-oapi-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      return await bootHttp(options);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * @case openapi.info auto-detects title and version from the nearest package.json
   * @preconditions No explicit builtins.openapi.info; cwd is switched to a
   *   tmpdir holding a plain app package.json (name + version, no workspaces)
   *   for the duration of plugin construction, then restored.
   * @expectedResult /openapi.json's `info` block carries the package.json `name`
   *   as `title` and the package.json `version` as `version`. Confirms the
   *   conservative auto-fill described on HttpOpenApiInfo (only public-by-nature
   *   fields; description / contact / license stay opt-in).
   */
  test("openapi.info auto-detects title and version from package.json", async () => {
    const bound = await bootHttpFromTmpPackage(
      { name: "acme-orders", version: "7.8.9" },
      {
        routes: craft()
          .id("oapi-info")
          .from(http({ path: "/oapi-info", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
        http: { port: 0 },
      },
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      info: {
        title: string;
        version: string;
        description?: string;
        contact?: unknown;
        license?: unknown;
      };
    };
    expect(doc.info.title).toBe("acme-orders");
    expect(doc.info.version).toBe("7.8.9");
    expect(doc.info.description).toBeUndefined();
    expect(doc.info.contact).toBeUndefined();
    expect(doc.info.license).toBeUndefined();
  });

  /**
   * @case openapi.info does not leak a workspace container's identity
   * @preconditions No explicit builtins.openapi.info; cwd is switched to a
   *   tmpdir whose package.json declares `workspaces` and carries its own
   *   private name + version (the run-from-monorepo-root scenario), then
   *   restored.
   * @expectedResult /openapi.json serves the neutral fallbacks "Routecraft
   *   HTTP API" / "0.0.0" instead of the container's name and version. The
   *   container is infrastructure, not a service identity, and its version
   *   drifts because release tooling never touches it.
   */
  test("openapi.info falls back to neutral defaults at a workspace root", async () => {
    const bound = await bootHttpFromTmpPackage(
      {
        name: "@acme/workspace",
        version: "0.1.0",
        private: true,
        workspaces: ["packages/*"],
      },
      {
        routes: craft()
          .id("oapi-info-ws")
          .from(http({ path: "/oapi-info-ws", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
        http: { port: 0 },
      },
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      info: { title: string; version: string };
    };
    expect(doc.info.title).toBe("Routecraft HTTP API");
    expect(doc.info.version).toBe("0.0.0");
  });

  /**
   * @case Explicit builtins.openapi.info overrides the package.json auto-detected defaults
   * @preconditions builtins.openapi.info supplies title, version, description, contact, license
   * @expectedResult Every supplied field surfaces on the resulting /openapi.json `info` block
   *   verbatim. Caller-supplied values always win over package.json detection.
   */
  test("openapi.info caller overrides win over package.json defaults", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("oapi-info-override")
        .from(http({ path: "/oapi-info-override", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: {
        port: 0,
        builtins: {
          openapi: {
            info: {
              title: "Orders API",
              version: "1.2.3",
              description: "Customer order management.",
              contact: { name: "Platform Team", email: "platform@example.com" },
              license: {
                name: "MIT",
                url: "https://opensource.org/license/mit",
              },
            },
          },
        },
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      info: {
        title: string;
        version: string;
        description?: string;
        contact?: { name?: string; email?: string };
        license?: { name?: string; url?: string };
      };
    };
    expect(doc.info.title).toBe("Orders API");
    expect(doc.info.version).toBe("1.2.3");
    expect(doc.info.description).toBe("Customer order management.");
    expect(doc.info.contact?.name).toBe("Platform Team");
    expect(doc.info.contact?.email).toBe("platform@example.com");
    expect(doc.info.license?.name).toBe("MIT");
    expect(doc.info.license?.url).toBe("https://opensource.org/license/mit");
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

describe("HTTP Source Adapter: raw body and webhook signatures", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  const WEBHOOK_SECRET = "whsec_test_secret";

  function signSha256Hex(body: string, secret = WEBHOOK_SECRET): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  function signSha1Hex(body: string, secret = WEBHOOK_SECRET): string {
    return createHmac("sha1", secret).update(body).digest("hex");
  }

  function stripeHeader(
    body: string,
    opts: { timestamp?: number; secret?: string; v1?: string } = {},
  ): string {
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const v1 =
      opts.v1 ??
      createHmac("sha256", opts.secret ?? WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    return `t=${timestamp},v1=${v1}`;
  }

  /**
   * @case rawBody opt-in attaches the exact wire bytes to the exchange
   * @preconditions Route uses http({ rawBody: true }); POST body contains unicode and significant whitespace
   * @expectedResult routecraft.http.rawBody is a Uint8Array byte-identical to what was sent, and the parsed body still arrives as the JSON object
   */
  test("rawBody: true attaches byte-faithful wire bytes alongside the parsed body", async () => {
    let captured: Uint8Array | undefined;
    let parsedBody: unknown;
    // Key order, embedded whitespace, and unicode are exactly what a
    // re-serialisation of the parsed object would not preserve.
    const wireBody = '{ "b":\t"émoji 🚀",  "a": 1 }';
    const bound = await bootHttp({
      routes: craft()
        .id("raw-echo")
        .from(http({ path: "/raw-echo", method: "POST", rawBody: true }))
        .process(async (ex) => {
          captured = ex.headers["routecraft.http.rawBody"];
          parsedBody = ex.body;
          return DefaultExchange.rewrap(ex, { body: { ok: true } });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/raw-echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wireBody,
    });
    expect(res.status).toBe(200);
    expect(captured).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(captured!).equals(Buffer.from(wireBody))).toBe(true);
    expect(parsedBody).toEqual({ b: "émoji 🚀", a: 1 });
  });

  /**
   * @case rawBody defaults to off
   * @preconditions Route uses http({...}) without rawBody
   * @expectedResult routecraft.http.rawBody is absent from the exchange headers
   */
  test("rawBody is absent by default", async () => {
    let sawKey = true;
    const bound = await bootHttp({
      routes: craft()
        .id("raw-off")
        .from(http({ path: "/raw-off", method: "POST" }))
        .process(async (ex) => {
          sawKey = "routecraft.http.rawBody" in ex.headers;
          return DefaultExchange.rewrap(ex, { body: { ok: true } });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/raw-off`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(sawKey).toBe(false);
  });

  /**
   * @case GitHub-style hmac-sha256-hex signature with prefix admits a valid delivery
   * @preconditions signature: { header: x-hub-signature-256, scheme: hmac-sha256-hex, prefix: "sha256=" }
   * @expectedResult Correctly signed request reaches the route and returns 200
   */
  test("hmac-sha256-hex with prefix admits a correctly signed request", async () => {
    const body = '{"action":"opened"}';
    const bound = await bootHttp({
      routes: craft()
        .id("gh-hook")
        .from(
          http({
            path: "/hooks/github",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body)}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  /**
   * @case Tampered body rejects before the route runs
   * @preconditions Valid signature computed for a different body than the one sent
   * @expectedResult 401 { error: "unauthorized", reason: "invalid signature" }; the route handler never executes
   */
  test("tampered body rejects 401 and the route never runs", async () => {
    let routeRan = false;
    const bound = await bootHttp({
      routes: craft()
        .id("gh-tamper")
        .from(
          http({
            path: "/hooks/tamper",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => {
          routeRan = true;
          return { received: true };
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/tamper`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex('{"a":1}')}`,
      },
      body: '{"a":2}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      reason: "invalid signature",
    });
    expect(routeRan).toBe(false);
  });

  /**
   * @case Wrong signing secret rejects
   * @preconditions Signature computed with a secret that differs from the route's
   * @expectedResult 401 with reason "invalid signature"
   */
  test("wrong secret rejects 401", async () => {
    const body = '{"a":1}';
    const bound = await bootHttp({
      routes: craft()
        .id("gh-wrong-secret")
        .from(
          http({
            path: "/hooks/ws",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/ws`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body, "other-secret")}`,
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case Missing signature header rejects with its own bounded reason
   * @preconditions signature configured; request sent without the header
   * @expectedResult 401 with reason "missing signature header"
   */
  test("missing signature header rejects 401 with bounded reason", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("gh-missing")
        .from(
          http({
            path: "/hooks/missing",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "missing signature header",
    );
  });

  /**
   * @case Legacy hmac-sha1-hex scheme verifies symmetrically
   * @preconditions signature: { scheme: hmac-sha1-hex, prefix: "sha1=" }
   * @expectedResult Valid sha1 signature admits; invalid rejects 401
   */
  test("hmac-sha1-hex admits valid and rejects invalid signatures", async () => {
    const body = '{"a":1}';
    const bound = await bootHttp({
      routes: craft()
        .id("gh-sha1")
        .from(
          http({
            path: "/hooks/sha1",
            method: "POST",
            signature: {
              header: "x-hub-signature",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha1-hex",
              prefix: "sha1=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const good = await fetch(`http://127.0.0.1:${bound.port}/hooks/sha1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": `sha1=${signSha1Hex(body)}`,
      },
      body,
    });
    expect(good.status).toBe(200);

    const bad = await fetch(`http://127.0.0.1:${bound.port}/hooks/sha1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": `sha1=${signSha1Hex(body, "other")}`,
      },
      body,
    });
    expect(bad.status).toBe(401);
  });

  /**
   * @case Stripe-timestamped scheme admits a fresh signature and rejects expiry and tampering distinctly
   * @preconditions signature: { scheme: stripe-timestamped } with default tolerance
   * @expectedResult Fresh t admits; t older than the tolerance rejects "signature expired"; tampered v1 rejects "invalid signature"
   */
  test("stripe-timestamped verifies freshness and integrity separately", async () => {
    const body = '{"type":"payment_intent.succeeded"}';
    const bound = await bootHttp({
      routes: craft()
        .id("stripe-hook")
        .from(
          http({
            path: "/hooks/stripe",
            method: "POST",
            signature: {
              header: "stripe-signature",
              secret: WEBHOOK_SECRET,
              scheme: "stripe-timestamped",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/stripe`;
    const headers = { "content-type": "application/json" };

    const fresh = await fetch(url, {
      method: "POST",
      headers: { ...headers, "stripe-signature": stripeHeader(body) },
      body,
    });
    expect(fresh.status).toBe(200);

    const stale = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "stripe-signature": stripeHeader(body, {
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        }),
      },
      body,
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { reason: string }).reason).toBe(
      "signature expired",
    );

    const tampered = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "stripe-signature": stripeHeader(body, { v1: "0".repeat(64) }),
      },
      body,
    });
    expect(tampered.status).toBe(401);
    expect(((await tampered.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case Length-mismatched signature value is an ordinary rejection
   * @preconditions Signature header carries a value shorter than a sha256 hex digest
   * @expectedResult 401 "invalid signature" through the same path as a same-length mismatch; no 500 from timingSafeEqual length constraints
   */
  test("signature of a different length rejects without throwing", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("gh-short")
        .from(
          http({
            path: "/hooks/short",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/short`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=abc123",
      },
      body: '{"a":1}',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case Oversized body is rejected 413 before any signature computation
   * @preconditions maxBodySize smaller than the payload; signature configured with a value that would also fail
   * @expectedResult 413 (size check), not 401 (signature check), proving the ordering
   */
  test("maxBodySize rejects 413 before the signature gate", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("gh-big")
        .from(
          http({
            path: "/hooks/big",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0, maxBodySize: 16 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/big`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=not-checked",
      },
      body: JSON.stringify({ padding: "x".repeat(64) }),
    });
    expect(res.status).toBe(413);
  });

  /**
   * @case Signature gate is independent of the mount wall
   * @preconditions Walled api mount plus a public default mount; the webhook
   *   route lives on the public mount with a signature gate
   * @expectedResult A correctly signed request with no Authorization header
   *   returns 200; the wall never applies because the mount, not the route,
   *   decides authentication
   */
  test("signature admits on a public mount alongside a walled api mount", async () => {
    const body = '{"a":1}';
    const bound = await bootHttp({
      routes: craft()
        .id("gh-public")
        .from(
          http({
            path: "/hooks/github",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: {
        port: 0,
        mounts: {
          api: {
            path: "/api",
            auth: jwt({
              secret: JWT_SECRET,
              issuer: JWT_ISSUER,
              audience: JWT_AUDIENCE,
            }),
          },
          default: { path: "/", auth: false },
        },
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body)}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  /**
   * @case signature on a bodyless method fails at construction
   * @preconditions http({ method: "GET", signature: {...} })
   * @expectedResult RC5003 thrown from the http({...}) call site, before any server exists
   */
  test("signature on GET throws RC5003 at construction time", () => {
    expect(() =>
      http({
        path: "/hooks/get",
        method: "GET",
        signature: {
          header: "x-hub-signature-256",
          secret: WEBHOOK_SECRET,
          scheme: "hmac-sha256-hex",
        },
      }),
    ).toThrow(/body-bearing method/);
  });

  /**
   * @case Invalid signature options fail at construction
   * @preconditions http({ signature }) with an empty secret
   * @expectedResult RC5003 thrown from the http({...}) call site
   */
  test("empty signature secret throws RC5003 at construction time", () => {
    expect(() =>
      http({
        path: "/hooks/bad-opts",
        method: "POST",
        signature: {
          header: "x-hub-signature-256",
          secret: "",
          scheme: "hmac-sha256-hex",
        },
      }),
    ).toThrow(/signature\.secret/);
  });

  /**
   * @case Unknown signature scheme fails at construction
   * @preconditions http({ signature }) with a scheme outside the supported set
   * @expectedResult RC5003 thrown from the http({...}) call site
   */
  test("unknown signature scheme throws RC5003 at construction time", () => {
    expect(() =>
      http({
        path: "/hooks/bad-scheme",
        method: "POST",
        signature: {
          header: "x-hub-signature-256",
          secret: WEBHOOK_SECRET,
          scheme: "hmac-md5-hex" as unknown as "hmac-sha256-hex",
        },
      }),
    ).toThrow(/signature\.scheme/);
  });

  /**
   * @case Unsupported method fails at construction
   * @preconditions http({ method }) with a value outside the HTTP method set
   * @expectedResult RC5003 thrown from the http({...}) call site instead of a dead route
   */
  test("unsupported method throws RC5003 at construction time", () => {
    expect(() =>
      http({ path: "/bad-method", method: "FETCH" as unknown as "POST" }),
    ).toThrow(/invalid method/);
  });

  /**
   * @case Empty body does not bypass the signature gate
   * @preconditions signature configured; POST with an empty body and no signature header
   * @expectedResult 401, proving the empty-body shortcut runs after verification
   */
  test("unsigned empty body rejects 401 on a signature-gated route", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("gh-empty")
        .from(
          http({
            path: "/hooks/empty",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const unsigned = await fetch(`http://127.0.0.1:${bound.port}/hooks/empty`, {
      method: "POST",
    });
    expect(unsigned.status).toBe(401);

    // A correctly signed empty body is still a valid delivery.
    const signed = await fetch(`http://127.0.0.1:${bound.port}/hooks/empty`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${signSha256Hex("")}` },
    });
    expect(signed.status).toBe(200);
  });

  /**
   * @case Signature rejection emits auth:rejected with the documented shape
   * @preconditions signature configured; one invalid delivery
   * @expectedResult auth:rejected fires with { reason, scheme: "signature", source: "http" }
   */
  test("signature rejection emits auth:rejected with scheme signature", async () => {
    const rejected: Array<Record<string, unknown>> = [];
    const bound = await bootHttp({
      routes: craft()
        .id("gh-event")
        .from(
          http({
            path: "/hooks/event",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
      events: {
        "auth:rejected": (ev) =>
          rejected.push(ev.details as Record<string, unknown>),
      },
    });
    t = bound.ctx;

    await fetch(`http://127.0.0.1:${bound.port}/hooks/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });

    expect(rejected[0]).toEqual({
      reason: "missing signature header",
      scheme: "signature",
      source: "http",
    });
  });

  /**
   * @case Illegal header name in signature options fails at construction
   * @preconditions signature.header contains a space (invalid RFC 7230 token)
   * @expectedResult RC5003 from the http({...}) call site, not a request-time TypeError
   */
  test("invalid signature.header token throws RC5003 at construction time", () => {
    expect(() =>
      http({
        path: "/hooks/bad-header",
        method: "POST",
        signature: {
          header: "x hub signature",
          secret: WEBHOOK_SECRET,
          scheme: "hmac-sha256-hex",
        },
      }),
    ).toThrow(/signature\.header/);
  });

  /**
   * @case Uppercase hex signatures verify (hex casing carries no information)
   * @preconditions Provider emits the HMAC digest in uppercase hex
   * @expectedResult Correctly signed request is admitted with 200
   */
  test("uppercase hex signature is accepted", async () => {
    const body = '{"a":1}';
    const bound = await bootHttp({
      routes: craft()
        .id("gh-upper")
        .from(
          http({
            path: "/hooks/upper",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/upper`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body).toUpperCase()}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  /**
   * @case Stripe scheme signs over the raw t field text, not a re-serialised parse of it
   * @preconditions t carries a leading zero; the sender signed over the exact raw field
   * @expectedResult Delivery verifies (200); a t with a junk suffix rejects as invalid signature
   */
  test("stripe scheme uses the raw t text and rejects malformed t", async () => {
    const body = '{"type":"x"}';
    const bound = await bootHttp({
      routes: craft()
        .id("stripe-rawt")
        .from(
          http({
            path: "/hooks/stripe-rawt",
            method: "POST",
            signature: {
              header: "stripe-signature",
              secret: WEBHOOK_SECRET,
              scheme: "stripe-timestamped",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/stripe-rawt`;
    const headers = { "content-type": "application/json" };

    // Leading-zero t: same numeric instant (within tolerance), different text.
    const rawT = `0${Math.floor(Date.now() / 1000)}`;
    const v1 = createHmac("sha256", WEBHOOK_SECRET)
      .update(`${rawT}.${body}`)
      .digest("hex");
    const leadingZero = await fetch(url, {
      method: "POST",
      headers: { ...headers, "stripe-signature": `t=${rawT},v1=${v1}` },
      body,
    });
    expect(leadingZero.status).toBe(200);

    // Non-digit t must reject as invalid signature, not silently truncate.
    const junk = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "stripe-signature": stripeHeader(body).replace(",v1=", "junk,v1="),
      },
      body,
    });
    expect(junk.status).toBe(401);
    expect(((await junk.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case rawBody does not alias a mutable exchange body
   * @preconditions Unknown content-type (body IS the raw bytes) with rawBody: true; a step mutates the body in place
   * @expectedResult routecraft.http.rawBody still carries the original wire bytes
   */
  test("rawBody stays byte-faithful when the octet-stream body is mutated in place", async () => {
    let rawAfterMutation: Uint8Array | undefined;
    const wire = new Uint8Array([1, 2, 3, 4]);
    const bound = await bootHttp({
      routes: craft()
        .id("raw-alias")
        .from(http({ path: "/raw-alias", method: "POST", rawBody: true }))
        .process(async (ex) => {
          (ex.body as Uint8Array)[0] = 99;
          rawAfterMutation = ex.headers["routecraft.http.rawBody"];
          return DefaultExchange.rewrap(ex, { body: { ok: true } });
        })
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/raw-alias`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: wire,
    });
    expect(res.status).toBe(200);
    expect(Array.from(rawAfterMutation!)).toEqual([1, 2, 3, 4]);
  });

  /**
   * @case Lowercase method from an untyped caller is normalised at registration
   * @preconditions http({ method: "post" }) via a JS-style cast
   * @expectedResult The route matches POST requests instead of silently 404ing
   */
  test("lowercase method is normalised so the route still matches", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("lower-method")
        .from(http({ path: "/lower", method: "post" as unknown as "POST" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      http: { port: 0 },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/lower`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
  });

  /**
   * The vector published by the Standard Webhooks reference implementation
   * (`libraries/javascript/src/webhook.test.ts`), not one this suite made up:
   * a signature computed by our own code and checked by our own code proves
   * only internal consistency, never interoperability with the senders the
   * scheme exists for.
   */
  const SW_VECTOR = {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
    payload: '{"test": 2432232314}',
    signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  } as const;

  /**
   * The reference vector is dated 2021, so a test that replays it has to take
   * the freshness check out of the picture to reach the signature comparison
   * at all. Freshness is exercised on its own below.
   */
  const IGNORE_FRESHNESS_SEC = 10_000_000_000;

  /** A well-formed base64 digest that is not the right one, from the reference suite. */
  const SW_WRONG_SIGNATURE = "Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=";

  function signStandardWebhooks(
    body: string,
    opts: { id?: string; timestamp?: number; secret?: string } = {},
  ): Record<string, string> {
    const id = opts.id ?? SW_VECTOR.id;
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const key = Buffer.from(
      (opts.secret ?? SW_VECTOR.secret).replace(/^whsec_/, ""),
      "base64",
    );
    const v1 = createHmac("sha256", key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${v1}`,
    };
  }

  async function bootStandardWebhooks(
    path: string,
    signature: Partial<{ secret: string; toleranceSec: number }> = {},
    onRun?: () => void,
  ): Promise<{ ctx: TestContext; port: number }> {
    return bootHttp({
      routes: craft()
        .id(`sw${path.replace(/\W/g, "-")}`)
        .from(
          http({
            path,
            method: "POST",
            signature: {
              scheme: "standard-webhooks",
              secret: signature.secret ?? SW_VECTOR.secret,
              ...(signature.toleranceSec !== undefined
                ? { toleranceSec: signature.toleranceSec }
                : {}),
            },
          }),
        )
        .transform(() => {
          onRun?.();
          return { received: true };
        })
        .to(noop()),
      http: { port: 0 },
    });
  }

  /**
   * @case The Standard Webhooks reference vector verifies with secret only
   * @preconditions signature: { scheme: "standard-webhooks", secret } and no header names configured; the specification's published id, timestamp, payload and signature
   * @expectedResult 200, proving the header defaults, the whsec_ decode and the <id>.<timestamp>.<body> payload all match the reference implementation
   */
  test("the specification's own reference vector verifies", async () => {
    const bound = await bootStandardWebhooks("/hooks/sw-vector", {
      toleranceSec: IGNORE_FRESHNESS_SEC,
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/sw-vector`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": SW_VECTOR.id,
        "webhook-timestamp": String(SW_VECTOR.timestamp),
        "webhook-signature": SW_VECTOR.signature,
      },
      body: SW_VECTOR.payload,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  /**
   * @case A freshly signed delivery verifies under the default tolerance
   * @preconditions Body signed now with the vector's secret; default toleranceSec
   * @expectedResult 200, so the scheme works without any timing indulgence
   */
  test("a freshly signed delivery verifies with the default tolerance", async () => {
    const body = '{"event":"message.received"}';
    const bound = await bootStandardWebhooks("/hooks/sw-fresh");
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/sw-fresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signStandardWebhooks(body),
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  /**
   * @case A rotated key set admits when any v1 entry matches and rejects when none does
   * @preconditions webhook-signature carrying two space-separated v1 entries
   * @expectedResult 200 when one of them is correct, 401 invalid signature when neither is
   */
  test("either signature of a rotated pair admits, neither rejects", async () => {
    const body = '{"event":"rotated"}';
    const bound = await bootStandardWebhooks("/hooks/sw-rotate");
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/sw-rotate`;
    const signed = signStandardWebhooks(body);
    const valid = signed["webhook-signature"]!;

    const first = await fetch(url, {
      method: "POST",
      headers: {
        ...signed,
        "webhook-signature": `${valid} v1,${SW_WRONG_SIGNATURE}`,
      },
      body,
    });
    expect(first.status).toBe(200);

    const second = await fetch(url, {
      method: "POST",
      headers: {
        ...signed,
        "webhook-signature": `v1,${SW_WRONG_SIGNATURE} ${valid}`,
      },
      body,
    });
    expect(second.status).toBe(200);

    const neither = await fetch(url, {
      method: "POST",
      headers: {
        ...signed,
        "webhook-signature": `v1,${SW_WRONG_SIGNATURE} v1,${SW_WRONG_SIGNATURE}`,
      },
      body,
    });
    expect(neither.status).toBe(401);
    expect(((await neither.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case Entries of another signature version are skipped rather than failing the delivery
   * @preconditions A v1a (asymmetric) entry beside a valid v1 entry, then a v1a entry alone
   * @expectedResult 200 for the pair, 401 invalid signature when only the unsupported version is offered
   */
  test("non-v1 entries are skipped, not treated as failures", async () => {
    const body = '{"event":"mixed-versions"}';
    const bound = await bootStandardWebhooks("/hooks/sw-versions");
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/sw-versions`;
    const signed = signStandardWebhooks(body);
    const asymmetric = `v1a,${SW_WRONG_SIGNATURE}`;

    const mixed = await fetch(url, {
      method: "POST",
      headers: {
        ...signed,
        "webhook-signature": `${asymmetric} ${signed["webhook-signature"]}`,
      },
      body,
    });
    expect(mixed.status).toBe(200);

    const onlyAsymmetric = await fetch(url, {
      method: "POST",
      headers: { ...signed, "webhook-signature": asymmetric },
      body,
    });
    expect(onlyAsymmetric.status).toBe(401);
    expect(((await onlyAsymmetric.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
  });

  /**
   * @case A timestamp outside toleranceSec rejects as expired in both directions
   * @preconditions Correctly signed deliveries dated well before and well after now, toleranceSec 300
   * @expectedResult 401 { reason: "signature expired" } for both, bounding replay of captured deliveries
   */
  test("a timestamp outside the tolerance rejects signature expired", async () => {
    const body = '{"event":"stale"}';
    const bound = await bootStandardWebhooks("/hooks/sw-stale", {
      toleranceSec: 300,
    });
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/sw-stale`;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const timestamp of [nowSec - 301, nowSec + 301]) {
      const res = await fetch(url, {
        method: "POST",
        headers: signStandardWebhooks(body, { timestamp }),
        body,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "signature expired",
      );
    }
  });

  /**
   * @case A delivery missing any of the three fixed headers rejects as missing, not invalid
   * @preconditions Correctly signed delivery with webhook-id, webhook-timestamp or webhook-signature removed
   * @expectedResult 401 { reason: "missing signature header" } in each case; nothing was presented to verify
   */
  test("a missing id, timestamp or signature header rejects as missing", async () => {
    const body = '{"event":"incomplete"}';
    const bound = await bootStandardWebhooks("/hooks/sw-missing");
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/hooks/sw-missing`;
    for (const omitted of [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]) {
      const headers = signStandardWebhooks(body);
      delete headers[omitted];
      const res = await fetch(url, { method: "POST", headers, body });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "missing signature header",
      );
    }
  });

  /**
   * @case A tampered body rejects before the route runs
   * @preconditions Signature computed over one body, a different body sent
   * @expectedResult 401 invalid signature and the route handler never executes
   */
  test("a tampered body rejects 401 and the route never runs", async () => {
    let routeRan = false;
    const bound = await bootStandardWebhooks(
      "/hooks/sw-tamper",
      {},
      () => void (routeRan = true),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/sw-tamper`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signStandardWebhooks('{"amount":1}'),
      },
      body: '{"amount":1000000}',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "invalid signature",
    );
    expect(routeRan).toBe(false);
  });

  /**
   * @case The secret is accepted with or without its whsec_ identification prefix
   * @preconditions The same delivery verified against a route configured with the bare base64 secret
   * @expectedResult 200, matching the reference implementation, which accepts both forms
   */
  test("the secret verifies with the whsec_ prefix stripped", async () => {
    const body = '{"event":"bare-secret"}';
    const bare = SW_VECTOR.secret.slice("whsec_".length);
    const bound = await bootStandardWebhooks("/hooks/sw-bare", {
      secret: bare,
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/sw-bare`, {
      method: "POST",
      headers: signStandardWebhooks(body, { secret: bare }),
      body,
    });
    expect(res.status).toBe(200);
  });

  /**
   * @case A secret that is not base64 fails at construction, not at the first delivery
   * @preconditions http({ signature: { scheme: "standard-webhooks", secret: "whsec_not base64!" } })
   * @expectedResult RC5003 thrown from the http({...}) call site, naming signature.secret
   */
  test("a non-base64 standard-webhooks secret throws RC5003 at construction", () => {
    expect(() =>
      http({
        path: "/hooks/sw-bad-secret",
        method: "POST",
        signature: {
          scheme: "standard-webhooks",
          secret: "whsec_not base64!",
        },
      }),
    ).toThrow(/signature\.secret/);

    // The prefix alone carries no key material, which the reference
    // implementation also rejects.
    expect(() =>
      http({
        path: "/hooks/sw-empty-secret",
        method: "POST",
        signature: { scheme: "standard-webhooks", secret: "whsec_" },
      }),
    ).toThrow(/signature\.secret/);
  });

  /**
   * @case The defaulted header name does not leak to the schemes that fix nothing
   * @preconditions http({ signature }) omitting header on hmac-sha256-hex, reached past the compiler with a cast
   * @expectedResult RC5003 naming signature.header, so only standard-webhooks defaults it
   */
  test("header stays required for the three schemes that fix no name", () => {
    expect(() =>
      http({
        path: "/hooks/no-header",
        method: "POST",
        signature: {
          secret: WEBHOOK_SECRET,
          scheme: "hmac-sha256-hex",
        } as unknown as {
          header: string;
          secret: string;
          scheme: "hmac-sha256-hex";
        },
      }),
    ).toThrow(/signature\.header/);
  });
});

/**
 * The inbound cap is not negotiable in the way the outbound one is.
 *
 * `http()`'s client accepts `Infinity` as a named opt-out, because there the
 * route author chose the endpoint and is spending their own process on a
 * response they asked for. Inbound, the caller is a stranger and
 * `parseRequestBody` buffers the whole request before it can measure it, so
 * an unbounded cap means one request can exhaust the process. The two sides
 * share a resolver, which is exactly why this needs a guard: the sharing is
 * what could quietly widen the plugin next time someone refactors it.
 */
describe("httpPlugin maxBodySize refuses unbounded", () => {
  /**
   * @case Infinity is refused as an inbound request cap
   * @preconditions httpPlugin constructed with maxBodySize: Infinity
   * @expectedResult RC5003 at construction, so the inbound cap can never be removed by configuration
   */
  test("refuses maxBodySize: Infinity", () => {
    let caught: unknown;
    try {
      httpPlugin({ maxBodySize: Number.POSITIVE_INFINITY });
    } catch (error) {
      caught = error;
    }

    expect((caught as { rc?: string } | undefined)?.rc).toBe("RC5003");
    expect((caught as Error).message).toContain("maxBodySize");
  });

  /**
   * @case The refusal does not advertise an opt-out the plugin does not offer
   * @preconditions httpPlugin constructed with an invalid maxBodySize
   * @expectedResult The message names positive integers only, never Infinity, so it does not point at a way out that this side refuses
   */
  test("does not offer Infinity in its refusal message", () => {
    let caught: unknown;
    try {
      httpPlugin({ maxBodySize: 0 });
    } catch (error) {
      caught = error;
    }

    expect((caught as { rc?: string } | undefined)?.rc).toBe("RC5003");
    expect((caught as Error).message).not.toContain("Infinity");
  });
});
