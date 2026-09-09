import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { signHs256, testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  OpsClientError,
  craft,
  direct,
  isSuspended,
  jwt,
  noop,
  opsPlugin,
  remotesPlugin,
  type HealthReport,
  type OpsPage,
  type OpsRouteDetail,
  type OpsRouteSummary,
  type RemotesConfig,
} from "../src/index.ts";
import { rcCodeOf } from "../src/brand.ts";

/**
 * The remotes plugin against a real second instance in the same process.
 *
 * The second instance carries the ops management API behind a JWT wall
 * with scope-gated tiers, exactly as the constrained server this feature
 * exists for would. The first names it twice, as `default` and as `lab`,
 * and every case below drives the imported endpoints through the code
 * paths a local route would use: `CraftClient.sendDirect`, a `direct()`
 * enricher, and the first instance's own ops door.
 */

const JWT_SECRET = "remotes-jwt-secret-please-change-me";
const JWT_ISSUER = "https://idp.test";
const JWT_AUDIENCE = "https://api.test";
const SUSPENSION_SECRET = "remotes-suspension-secret-0123456789";

/**
 * A credential admitted to both tiers, minted per request: the helper's
 * tokens live for a minute, and a suite must not depend on finishing in one.
 */
const operator = (): string =>
  signHs256({
    secret: JWT_SECRET,
    claims: { scope: "ops:introspection ops:dispatch" },
  });
/** A credential admitted to the listing and refused at dispatch. */
const reader = (): string =>
  signHs256({ secret: JWT_SECRET, claims: { scope: "ops:introspection" } });
/** The base64url head every HS256 JWT starts with, which no log line may carry. */
const JWT_HEAD = "eyJhbGciOi";
/** Not a credential at all; distinctive so a log line carrying it is findable. */
const FORGED = "forged-bearer-0f3a9c1e-never-log-me";

/** Whatever the test harness accepts as a route list. */
type Routes = Parameters<ReturnType<typeof testContext>["routes"]>[0];

interface Instance {
  t: TestContext;
  port: number;
}

/** The four route shapes an outcome mapping has to cover. */
function serverRoutes(): Routes {
  return [
    craft()
      .id("hello")
      .description("Say hello")
      .input({ body: z.object({ name: z.string() }) })
      .output({ body: z.object({ greeting: z.string() }) })
      .from(direct())
      .transform((body) => ({ greeting: `hello ${body.name}` }))
      .to(noop()),
    craft()
      .id("boom")
      .description("Always fails")
      .input({ body: z.object({}) })
      .from(direct())
      .process(() => {
        throw new Error("kaboom");
      })
      .to(noop()),
    craft()
      .id("picky")
      .description("Drops everything")
      .input({ body: z.object({}) })
      .from(direct())
      .filter(() => false)
      .to(noop()),
    craft()
      .id("payout")
      .description("Parks until approved")
      .input({ body: z.object({}) })
      .from(direct())
      .suspend({ schema: z.object({ approved: z.boolean() }) })
      .to(noop()),
  ];
}

/**
 * The instance whose routes are imported: an ops surface behind a JWT
 * wall, both tiers scope-gated. Port 0 asks the OS for a free one unless
 * the test needs a port it reserved earlier.
 */
async function startServer(options: { port?: number } = {}): Promise<Instance> {
  const t = await testContext()
    .with({
      servers: { default: { port: options.port ?? 0, host: "127.0.0.1" } },
      suspension: {
        store: new MemorySuspensionStore(),
        secret: SUSPENSION_SECRET,
      },
      plugins: [
        opsPlugin({
          auth: jwt({
            secret: JWT_SECRET,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          }),
          tiers: {
            introspection: "ops:introspection",
            dispatch: "ops:dispatch",
          },
        }),
      ],
    })
    .routes(serverRoutes())
    .build();
  return { t, port: await listen(t) };
}

/**
 * The instance that imports. Carries an open ops door of its own so the
 * re-exposure of imported routes can be read and dispatched through it.
 */
async function startLocal(options: {
  remotes: RemotesConfig;
  routes?: Routes;
  onBuilt?: (t: TestContext) => void;
}): Promise<Instance> {
  const t = await testContext()
    .with({
      servers: { default: { port: 0, host: "127.0.0.1" } },
      ops: { tiers: { introspection: true, dispatch: true } },
      remotes: options.remotes,
    })
    .routes(options.routes ?? [])
    .build();
  options.onBuilt?.(t);
  return { t, port: await listen(t) };
}

async function listen(t: TestContext): Promise<number> {
  let port: number | undefined;
  t.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await t.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  return port;
}

/** A port nothing listens on right now, for an instance that comes up later. */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/** A stand-in ops server, for the one case a real instance cannot stage. */
async function serveFake(
  handle: (pathname: string) => { status: number; body?: unknown },
): Promise<{ port: number; close(): Promise<void> }> {
  const fake = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
    const answer = handle(pathname);
    if (answer.body === undefined) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  return {
    port: (fake.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        fake.closeAllConnections();
        fake.close(() => resolve());
      }),
  };
}

interface Fetched<T> {
  status: number;
  body: T;
}

async function call<T>(
  port: number,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Fetched<T>> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
  };
}

/** Capture every line the context logs, at every level, rendered to text. */
function captureLogs(ctx: TestContext["ctx"]): {
  warnings: string[];
  everything: string[];
} {
  const warnings: string[] = [];
  const everything: string[] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const original = ctx.logger[level].bind(ctx.logger);
    ctx.logger[level] = ((first: unknown, second?: unknown) => {
      const rendered = [renderLogArgument(first), renderLogArgument(second)]
        .filter((part) => part !== undefined)
        .join(" ");
      everything.push(rendered);
      if (level === "warn") warnings.push(rendered);
      return original(first as never, second as never);
    }) as (typeof ctx.logger)[typeof level];
  }
  return { warnings, everything };
}

function renderLogArgument(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry instanceof Error
      ? { message: entry.message, cause: entry.cause }
      : entry,
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("remotes", () => {
  let server: Instance | undefined;
  let local: Instance | undefined;

  // Typed loosely on purpose: the endpoints under test are the imported
  // ones, which no local registry declares.
  const send = (endpoint: string, body: unknown): Promise<unknown> =>
    local!.t.client.sendDirect(endpoint, body);

  afterEach(async () => {
    // The importer stops first so its teardown releases the endpoints while
    // the remote is still there to have been imported from.
    if (local) await local.t.stop();
    if (server) await server.t.stop();
    local = undefined;
    server = undefined;
  });

  /**
   * @case The remote's dispatchable routes become direct endpoints, bare for `default` and qualified for every other remote
   * @preconditions A second instance with a scope-gated ops surface; the first names it as `default` and as `lab`, and carries a local route that enriches from `lab:hello`
   * @expectedResult `hello`, `default:hello` and `lab:hello` are capabilities carrying their remote's name; `sendDirect` on each and the enricher on the local route return the second instance's result. Git-style naming is what lets `direct('hello')` reach the server with nothing to learn while two remotes never collide
   */
  test("imports routes as direct endpoints under git-style names", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    local = await startLocal({
      remotes: {
        default: { url, auth: { token: operator } },
        lab: { url, auth: { token: operator } },
      },
      routes: [
        craft()
          .id("caller")
          .from(direct())
          .enrich(direct("lab:hello"))
          .to(noop()),
      ],
    });

    const capabilities = local.t.ctx.capabilities();
    const byEndpoint = new Map(capabilities.map((c) => [c.endpoint, c]));
    expect(byEndpoint.get("hello")?.remote).toBe("default");
    expect(byEndpoint.get("default:hello")?.remote).toBe("default");
    expect(byEndpoint.get("lab:hello")?.remote).toBe("lab");
    expect(byEndpoint.get("lab:hello")?.description).toBe("Say hello");
    expect(byEndpoint.get("caller")?.remote).toBeUndefined();

    expect(await send("hello", { name: "bare" })).toEqual({
      greeting: "hello bare",
    });
    expect(await send("default:hello", { name: "qualified" })).toEqual({
      greeting: "hello qualified",
    });
    expect(await send("lab:hello", { name: "lab" })).toEqual({
      greeting: "hello lab",
    });
    expect(await send("caller", { name: "enrich" })).toEqual({
      greeting: "hello enrich",
    });
  });

  /**
   * @case The local ops door lists imported routes with their origin and dispatches one
   * @preconditions Both remotes imported; the first instance's introspection and dispatch tiers open
   * @expectedResult `GET /ops/routes?source=remote` lists every imported endpoint as dispatchable with `sources: ["remote"]` and a `remote` field; the detail carries the remote's JSON Schema; a POST to the exchanges path returns the second instance's result. This is what `craft ops routes` and `craft exec` read, and it is the intentional re-exposure: an open dispatch tier re-exports every imported route under the local door
   */
  test("lists and dispatches imported routes through the local door", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    local = await startLocal({
      remotes: {
        default: { url, auth: { token: operator } },
        lab: { url, auth: { token: operator } },
      },
    });

    const listing = await call<OpsPage<OpsRouteSummary>>(
      local.port,
      "/ops/routes?source=remote",
    );
    expect(listing.status).toBe(200);
    const ids = listing.body.items.map((route) => route.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(
      expect.arrayContaining(["hello", "default:hello", "lab:hello"]),
    );
    for (const route of listing.body.items) {
      expect(route.dispatchable).toBe(true);
      expect(route.sources).toEqual(["remote"]);
      expect(route.remote).toBe(
        route.id.startsWith("lab:") ? "lab" : "default",
      );
    }

    const detail = await call<OpsRouteDetail>(
      local.port,
      `/ops/routes/${encodeURIComponent("lab:hello")}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.remote).toBe("lab");
    expect(detail.body.input?.body).toMatchObject({
      properties: { name: { type: "string" } },
    });

    const dispatched = await call<{ outcome: string; body: unknown }>(
      local.port,
      `/ops/routes/${encodeURIComponent("lab:hello")}/exchanges`,
      { method: "POST", body: { name: "door" } },
    );
    expect(dispatched.status).toBe(200);
    expect(dispatched.body).toEqual({
      outcome: "completed",
      body: { greeting: "hello door" },
    });
  });

  /**
   * @case A local route with the same id as a default-remote route wins, loudly
   * @preconditions A local `hello` beside the default remote's `hello`
   * @expectedResult The local route answers `hello`; `default:hello` reaches the remote; a warning names the shadow when the inventory is read and again on every call that resolves to the local route; the local listing carries one `hello`, the local one. The overlap is the promotion window, so it is never an error
   */
  test("lets a local route shadow a default-remote route with a warning on refresh and on call", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    let warnings: string[] = [];
    local = await startLocal({
      remotes: { default: { url, auth: { token: operator } } },
      routes: [
        craft()
          .id("hello")
          .description("The local greeter")
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .transform(() => ({ greeting: "local" }))
          .to(noop()),
      ],
      onBuilt: (t) => {
        warnings = captureLogs(t.ctx).warnings;
      },
    });

    expect(
      warnings.filter((line) =>
        line.includes(
          'Local route "hello" shadows route "hello" of remote "default"',
        ),
      ),
    ).toHaveLength(1);

    const seen = warnings.length;
    expect(await send("hello", { name: "x" })).toEqual({
      greeting: "local",
    });
    expect(
      warnings
        .slice(seen)
        .filter((line) =>
          line.includes('"hello" is answered by the local route'),
        ),
    ).toHaveLength(1);
    expect(await send("default:hello", { name: "x" })).toEqual({
      greeting: "hello x",
    });

    const listing = await call<OpsPage<OpsRouteSummary>>(
      local.port,
      "/ops/routes?id=hello",
    );
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0]).toMatchObject({
      id: "hello",
      sources: ["direct"],
    });
    expect(listing.body.items[0]!.remote).toBeUndefined();
  });

  /**
   * @case A shadowing local route that stops hands the endpoint to the remote route, provenance included
   * @preconditions A local `hello` shadowing the default remote's `hello`, with the remote refreshing every 100ms
   * @expectedResult While the local route runs, `hello` is a local capability and answers locally. After `route.stop()` the capability carries `remote: "default"`, the local listing shows it as imported, a send reaches the remote, and the next inventory refresh keeps it that way. A tool policy reading `source.remote` must never see a local endpoint that dispatches elsewhere
   */
  test("hands a shadowed endpoint to the remote route when the local route stops", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    let everything: string[] = [];
    local = await startLocal({
      remotes: {
        default: { url, auth: { token: operator }, refresh: "100ms" },
      },
      routes: [
        craft()
          .id("hello")
          .description("The local greeter")
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .transform(() => ({ greeting: "local" }))
          .to(noop()),
      ],
      onBuilt: (t) => {
        everything = captureLogs(t.ctx).everything;
      },
    });
    const capability = () =>
      local!.t.ctx.capabilities().find((c) => c.endpoint === "hello");

    expect(capability()?.remote).toBeUndefined();
    expect(await send("hello", { name: "x" })).toEqual({ greeting: "local" });

    const route = local.t.ctx
      .getRoutes()
      .find((r) => r.definition.id === "hello");
    if (route === undefined) throw new Error("the local route is missing");
    route.stop();
    await until(
      () => capability()?.remote === "default",
      "the endpoint to become the remote's",
    );

    expect(capability()?.description).toBe("Say hello");
    expect(await send("hello", { name: "x" })).toEqual({
      greeting: "hello x",
    });
    expect(
      everything.filter((line) =>
        line.includes('The local route on "hello" has stopped'),
      ),
    ).toHaveLength(1);
    const listing = await call<OpsPage<OpsRouteSummary>>(
      local.port,
      "/ops/routes?id=hello",
    );
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0]).toMatchObject({
      id: "hello",
      sources: ["remote"],
      remote: "default",
    });

    // Two refresh intervals later the inventory has been reconciled against
    // the new provenance at least once and must not have re-shadowed it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(capability()?.remote).toBe("default");
    expect(await send("hello", { name: "again" })).toEqual({
      greeting: "hello again",
    });
  });

  /**
   * @case A local route that stopped before the first inventory arrived does not shadow the remote route
   * @preconditions A local `hello` beside a default remote that is unreachable at boot; the local route is stopped, then the remote comes up and is imported
   * @expectedResult The inventory finds the stale local capability and a dead channel, and installs the remote route over both: `hello` carries `remote: "default"`, dispatches to the remote, and is listed as imported. A registry entry that outlived its route must never be read as a live shadow
   */
  test("does not let a route stopped before the inventory shadow the remote route", async () => {
    const port = await reservePort();
    local = await startLocal({
      remotes: {
        default: {
          url: `http://127.0.0.1:${String(port)}`,
          auth: { token: operator },
          refresh: "100ms",
        },
      },
      routes: [
        craft()
          .id("hello")
          .description("The local greeter")
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .transform(() => ({ greeting: "local" }))
          .to(noop()),
      ],
    });
    const capability = () =>
      local!.t.ctx.capabilities().find((c) => c.endpoint === "hello");
    expect(capability()?.remote).toBeUndefined();

    const route = local.t.ctx
      .getRoutes()
      .find((r) => r.definition.id === "hello");
    if (route === undefined) throw new Error("the local route is missing");
    route.stop();
    expect(rcCodeOf(await rejection(send("hello", { name: "x" })))).toBe(
      "RC5004",
    );

    server = await startServer({ port });
    await until(
      () => capability()?.remote === "default",
      "the remote route to take the endpoint",
    );
    expect(await send("hello", { name: "late" })).toEqual({
      greeting: "hello late",
    });
    const listing = await call<OpsPage<OpsRouteSummary>>(
      local.port,
      "/ops/routes?id=hello",
    );
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0]).toMatchObject({
      id: "hello",
      sources: ["remote"],
      remote: "default",
    });
  });

  /**
   * @case A shadowing local route disabled by `.enabled()` hands the endpoint to the remote route, and takes it back when re-enabled
   * @preconditions A local `hello` with an `.enabled()` predicate beside the default remote's `hello`
   * @expectedResult Enabled, the local route answers and the capability is local. Disabled through `reevaluateEnablement`, the capability carries `remote: "default"`, the listing shows the imported route, and a send reaches the remote: a disabled local route must not hide the remote route that shares its id, on the tool surface or at the door. Re-enabled, the local route wins again
   */
  test("hands a shadowed endpoint to the remote route while the local route is disabled", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    let on = true;
    local = await startLocal({
      remotes: { default: { url, auth: { token: operator } } },
      routes: [
        craft()
          .id("hello")
          .description("The local greeter")
          .enabled(() => (on ? true : "switched off"))
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .transform(() => ({ greeting: "local" }))
          .to(noop()),
      ],
    });
    const capability = () =>
      local!.t.ctx.capabilities().find((c) => c.endpoint === "hello");
    expect(capability()?.remote).toBeUndefined();
    expect(await send("hello", { name: "x" })).toEqual({ greeting: "local" });

    on = false;
    await local.t.ctx.reevaluateEnablement("hello");
    await until(
      () => capability()?.remote === "default",
      "the remote route to take the endpoint",
    );
    expect(await send("hello", { name: "x" })).toEqual({
      greeting: "hello x",
    });
    const listing = await call<OpsPage<OpsRouteSummary>>(
      local.port,
      "/ops/routes?id=hello",
    );
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0]).toMatchObject({
      id: "hello",
      sources: ["remote"],
      remote: "default",
    });

    on = true;
    await local.t.ctx.reevaluateEnablement("hello");
    await until(
      () => capability()?.remote === undefined,
      "the local route to take the endpoint back",
    );
    expect(await send("hello", { name: "x" })).toEqual({ greeting: "local" });
  });

  /**
   * @case A connection lost after the request was sent is not retryable; one that never opened is
   * @preconditions A stand-in remote that lists one route and, on dispatch, reads the body and drops the socket without answering; then the same remote gone entirely
   * @expectedResult The dropped dispatch is `RC5062` with `retryable: false` and a message saying the remote may have received the request; the dispatch against the closed port is `RC5062` with `retryable: true`. A route that may already have run must not be retried by the framework's default policy
   */
  test("marks a connection lost after dispatch as not retryable", async () => {
    let executions = 0;
    const detail: OpsRouteDetail = {
      id: "hello",
      description: "Say hello",
      sources: ["direct"],
      dispatchable: true,
    } as OpsRouteDetail;
    const fake = createServer((req, res) => {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST") {
        req.on("data", () => undefined);
        req.on("end", () => {
          executions += 1;
          res.destroy();
        });
        return;
      }
      const body =
        pathname === "/ops/routes"
          ? { items: [detail] }
          : pathname === "/ops/routes/hello"
            ? detail
            : undefined;
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Each request on its own connection: a socket dropped mid-reuse reads
      // as a stale keep-alive to the client, which then retries on a fresh
      // one, and this case is about a request that provably ran once.
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = (fake.address() as AddressInfo).port;
    local = await startLocal({
      remotes: { lab: { url: `http://127.0.0.1:${String(port)}` } },
    });

    const dropped = await rejection(send("lab:hello", { name: "x" }));
    expect(rcCodeOf(dropped)).toBe("RC5062");
    expect((dropped as { retryable?: boolean }).retryable).toBe(false);
    expect(dropped.message).toContain("may have received the request");
    expect(executions).toBe(1);

    await new Promise<void>((resolve) => {
      fake.closeAllConnections();
      fake.close(() => resolve());
    });
    const refused = await rejection(send("lab:hello", { name: "x" }));
    expect(rcCodeOf(refused)).toBe("RC5062");
    expect((refused as { retryable?: boolean }).retryable).toBe(true);
    expect(refused.message).toContain("Could not reach a running instance");
    expect(executions).toBe(1);
  });

  /**
   * @case Every dispatch outcome maps onto the in-process one, against the real door
   * @preconditions Routes on the remote that complete, drop, park and fail; one remote named with a credential admitted to the listing but not to dispatch
   * @expectedResult completed is the body; dropped is `RC5031`; suspended is the branded `Suspended` acknowledgment; a remote failure is `RC5064` carrying the remote's code with the client's error as cause; the refused dispatch is `RC5063` naming the missing scope. A caller can tell a credential problem from a broken route
   */
  test("maps completed, dropped, suspended, failed and refused onto local outcomes", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    local = await startLocal({
      remotes: {
        lab: { url, auth: { token: operator } },
        reader: { url, auth: { token: reader } },
      },
    });

    expect(await send("lab:hello", { name: "ok" })).toEqual({
      greeting: "hello ok",
    });

    const dropped = await rejection(send("lab:picky", {}));
    expect(rcCodeOf(dropped)).toBe("RC5031");

    const parked = await send("lab:payout", {});
    expect(isSuspended(parked)).toBe(true);
    expect((parked as { suspensionId: string }).suspensionId).toBeTruthy();

    const failed = await rejection(send("lab:boom", {}));
    expect(rcCodeOf(failed)).toBe("RC5064");
    expect(failed.message).toMatch(/route "boom" on remote "lab"/);
    expect(failed.message).toMatch(/RC\d{4}/);
    expect(failed.cause).toBeInstanceOf(OpsClientError);
    expect((failed.cause as OpsClientError).status).toBe(500);

    const refused = await rejection(send("reader:hello", { name: "no" }));
    expect(rcCodeOf(refused)).toBe("RC5063");
    expect(refused.message).toMatch(/ops:dispatch/);
  });

  /**
   * @case The credential is read per request and never written anywhere a reader could see it
   * @preconditions One remote whose token is a counting function; one remote configured with a forged bearer the door rejects
   * @expectedResult The function is called once per request the inventory needs and once more per dispatch; the forged remote imports nothing, its inventory failure is logged as a warning, and no log line or error message carries the bearer
   */
  test("evaluates the token per request and keeps it out of logs and errors", async () => {
    server = await startServer();
    const url = `http://127.0.0.1:${String(server.port)}`;
    let reads = 0;
    let logs: ReturnType<typeof captureLogs> | undefined;
    local = await startLocal({
      remotes: {
        lab: {
          url,
          auth: {
            token: () => {
              reads += 1;
              return operator();
            },
          },
        },
        bad: { url, auth: { token: FORGED } },
      },
      onBuilt: (t) => {
        logs = captureLogs(t.ctx);
      },
    });

    // One listing plus one description per route the listing returned.
    const routes = (serverRoutes() as readonly unknown[]).length;
    expect(reads).toBe(1 + routes);
    await send("lab:hello", { name: "count" });
    expect(reads).toBe(2 + routes);

    const endpoints = local.t.ctx.capabilities().map((c) => c.endpoint);
    expect(endpoints.some((endpoint) => endpoint.startsWith("bad:"))).toBe(
      false,
    );
    expect(
      logs!.warnings.some((line) =>
        line.includes('Remote "bad" inventory could not be read'),
      ),
    ).toBe(true);
    expect(logs!.everything.some((line) => line.includes(FORGED))).toBe(false);
    expect(logs!.everything.some((line) => line.includes(JWT_HEAD))).toBe(
      false,
    );
  });

  /**
   * @case A dispatch that meets a 404 forces a refresh, and a route the remote no longer lists stops being an endpoint
   * @preconditions A stand-in ops server that lists `ghost` at boot, answers 404 to its dispatch, and no longer lists it by then; the interval refresh disabled
   * @expectedResult The dispatch fails with `RC5004` after the inventory was re-read; `lab:ghost` is gone from the capabilities and a second dispatch finds no channel at all. The inventory is the framework's to keep true, and the door is where a stale entry is found out
   */
  test("refreshes the inventory when a dispatch meets a 404", async () => {
    let listed = ["ghost"];
    const summary = (id: string): OpsRouteSummary => ({
      id,
      dispatchable: true,
      enabled: true,
      sources: ["direct"],
      requiresPrincipal: false,
      description: "A route that will vanish",
    });
    const fake = await serveFake((pathname) => {
      if (pathname === "/ops/routes") {
        return { status: 200, body: { items: listed.map(summary) } };
      }
      const one = /^\/ops\/routes\/([^/]+)$/.exec(pathname);
      if (one !== null && listed.includes(decodeURIComponent(one[1]!))) {
        return {
          status: 200,
          body: {
            ...summary(decodeURIComponent(one[1]!)),
            input: { body: { type: "object" } },
          },
        };
      }
      return { status: 404 };
    });
    try {
      local = await startLocal({
        remotes: {
          lab: { url: `http://127.0.0.1:${String(fake.port)}`, refresh: false },
        },
      });
      const has = (endpoint: string): boolean =>
        local!.t.ctx.capabilities().some((c) => c.endpoint === endpoint);
      expect(has("lab:ghost")).toBe(true);

      listed = [];
      const missing = await rejection(send("lab:ghost", {}));
      expect(rcCodeOf(missing)).toBe("RC5004");
      expect(missing.message).toMatch(/inventory has been refreshed/);
      expect(has("lab:ghost")).toBe(false);

      const gone = await rejection(send("lab:ghost", {}));
      expect(rcCodeOf(gone)).toBe("RC5004");
      expect(gone.message).toMatch(/No direct channel/);
    } finally {
      await fake.close();
    }
  });

  /**
   * @case A remote unreachable at boot registers nothing and its routes appear when it answers
   * @preconditions The first instance names a port nothing listens on, with a short refresh interval; the second instance is started on that port afterwards
   * @expectedResult The first instance starts, imports nothing for the remote and reports the `remote.lab` indicator down on its own health endpoint; after the second comes up a refresh imports its routes and the indicator reports up. An unreachable remote must not fail the boot, and must not need a restart to be found
   */
  test("starts without an unreachable remote and imports it once it answers", async () => {
    const port = await reservePort();
    local = await startLocal({
      remotes: {
        lab: {
          url: `http://127.0.0.1:${String(port)}`,
          auth: { token: operator },
          refresh: "100ms",
        },
      },
    });
    const has = (endpoint: string): boolean =>
      local!.t.ctx.capabilities().some((c) => c.endpoint === endpoint);
    expect(has("lab:hello")).toBe(false);

    const down = await call<HealthReport>(local.port, "/health");
    expect(down.body.indicators["remote.lab"]?.status).toBe("down");

    server = await startServer({ port });
    await until(() => has("lab:hello"), "the remote's routes to be imported");
    const up = await call<HealthReport>(local.port, "/health");
    expect(up.body.indicators["remote.lab"]?.status).toBe("up");
    expect(await send("lab:hello", { name: "late" })).toEqual({
      greeting: "hello late",
    });
  });

  /**
   * @case Configuration mistakes fail at definition, not at the first refresh
   * @preconditions A remote name that would break the tool wire name; a bearer over plain http to a non-loopback host; a malformed url
   * @expectedResult Each is refused with `RC5003` naming the key. The clear-text rule is the CLI's, for the same reason: every hop between here and the remote could read the token
   */
  test("refuses a bad remote name, a clear-text bearer and a malformed url", () => {
    const attempt = (remotes: RemotesConfig): string | undefined => {
      try {
        remotesPlugin(remotes);
        return undefined;
      } catch (error: unknown) {
        return `${rcCodeOf(error) ?? "?"} ${(error as Error).message}`;
      }
    };
    expect(attempt({ my__lab: { url: "https://lab.test" } })).toMatch(
      /^RC5003 remotes\.my__lab/,
    );
    expect(
      attempt({ lab: { url: "http://lab.test", auth: { token: "t" } } }),
    ).toMatch(/^RC5003 .*clear text/);
    expect(attempt({ lab: { url: "not a url" } })).toMatch(
      /^RC5003 remotes\.lab\.url/,
    );
    expect(
      attempt({ lab: { url: "http://127.0.0.1:1", auth: { token: "t" } } }),
    ).toBeUndefined();
  });
});
