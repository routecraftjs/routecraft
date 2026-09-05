import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  apiKey,
  craft,
  direct,
  noop,
  opsPlugin,
  parsePageQuery,
  rcError,
  registerOpsResource,
  type CraftPlugin,
  type HttpAuth,
  type OpsResource,
  type Principal,
} from "../src/index.ts";

/**
 * Contributed management resources: what another package registers on the
 * context and the ops mount serves under `/ops/{name}` on the introspection
 * tier. The mount owns admission and the wire; the contributor owns the
 * two reads.
 */

const KEYS: Record<string, string[]> = {
  reader: ["ops:introspection"],
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

/** A resource whose items are what its contributor put there. */
function widgets(items: Array<{ id: string; colour: string }>): OpsResource {
  return {
    name: "widgets",
    list: async (query) => ({
      items:
        query["colour"] === undefined
          ? items
          : items.filter((w) => w.colour === query["colour"]),
    }),
    describe: async (segments) =>
      segments.length === 1
        ? items.find((w) => w.id === segments[0])
        : segments.length === 2
          ? { id: segments.join("/"), nested: true }
          : undefined,
  };
}

function contributing(resource: OpsResource): CraftPlugin {
  return {
    name: "widgets",
    apply(ctx) {
      registerOpsResource(ctx, resource);
    },
  };
}

async function call<T>(
  port: number,
  path: string,
  init: { method?: string; key?: string } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: init.key === undefined ? {} : { "x-api-key": init.key },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
  };
}

describe("contributed management resources", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function start(options: {
    introspection?: boolean | string;
    auth?: HttpAuth;
    plugins?: CraftPlugin[];
    /** Apply the contributor after the ops plugin, to prove order does not matter. */
    after?: boolean;
  }): Promise<number> {
    const ops = opsPlugin({
      ...(options.auth !== undefined ? { auth: options.auth } : {}),
      ...(options.introspection !== undefined
        ? { tiers: { introspection: options.introspection } }
        : {}),
    });
    const contributors = options.plugins ?? [
      contributing(
        widgets([
          { id: "a", colour: "red" },
          { id: "b", colour: "blue" },
        ]),
      ),
    ];
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: options.after
          ? [ops, ...contributors]
          : [...contributors, ops],
      })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  /**
   * @case A contributed resource is listed, filtered and described under /ops/{name}
   * @preconditions A plugin registers "widgets" with two items; the introspection tier is open
   * @expectedResult GET /ops/widgets answers the items envelope, ?colour= narrows it, GET /ops/widgets/a answers the item, and a two-segment path reaches describe with both segments decoded
   */
  test("serves a contributed resource on the introspection tier", async () => {
    const port = await start({ introspection: true });
    const list = await call<{ items: unknown[] }>(port, "/ops/widgets");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);

    const red = await call<{ items: Array<{ id: string }> }>(
      port,
      "/ops/widgets?colour=red",
    );
    expect(red.body.items.map((w) => w.id)).toEqual(["a"]);

    const one = await call<{ id: string }>(port, "/ops/widgets/a");
    expect(one.status).toBe(200);
    expect(one.body.id).toBe("a");

    const nested = await call<{ id: string; nested: boolean }>(
      port,
      "/ops/widgets/max/s%2F1",
    );
    expect(nested.status).toBe(200);
    expect(nested.body).toEqual({ id: "max/s/1", nested: true });
  });

  /**
   * @case A resource registered after the ops plugin applied is served too
   * @preconditions The contributor is the last plugin in the list
   * @expectedResult GET /ops/widgets answers 200, because the mount reads the registry per request rather than at mount time
   */
  test("registration order does not matter", async () => {
    const port = await start({ introspection: true, after: true });
    expect((await call(port, "/ops/widgets")).status).toBe(200);
  });

  /**
   * @case An unknown resource, an unknown item and a wrong method answer as the mount's own paths do
   * @preconditions Only "widgets" is registered; the introspection tier is open
   * @expectedResult /ops/gadgets and /ops/widgets/zzz answer 404; POST /ops/widgets answers 405 with GET, HEAD allowed
   */
  test("answers 404 for what is not there and 405 for a write", async () => {
    const port = await start({ introspection: true });
    expect((await call(port, "/ops/gadgets")).status).toBe(404);
    expect((await call(port, "/ops/widgets/zzz")).status).toBe(404);
    const post = await fetch(`http://127.0.0.1:${port}/ops/widgets`, {
      method: "POST",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  /**
   * @case The introspection tier gates a contributed resource exactly as it gates the route listing
   * @preconditions The tier is scope-gated; three callers: no credential, a credential without the scope, a credential with it
   * @expectedResult 401 with no credential, 403 insufficient_scope without the scope, 200 with it; with the tier unset every path answers 404 whether or not the resource exists
   */
  test("the tier gates the resource", async () => {
    const port = await start({
      introspection: "ops:introspection",
      auth: keyAuth(),
    });
    expect((await call(port, "/ops/widgets")).status).toBe(401);
    const refused = await call<{ reason: string }>(port, "/ops/widgets", {
      key: "nobody",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("insufficient_scope");
    expect((await call(port, "/ops/widgets", { key: "reader" })).status).toBe(
      200,
    );
    await t!.stop();
    t = undefined;

    const dark = await start({});
    expect((await call(dark, "/ops/widgets")).status).toBe(404);
    expect((await call(dark, "/ops/gadgets")).status).toBe(404);
  });

  /**
   * @case A contributor that throws is answered by the mount, in the mount's vocabulary
   * @preconditions A resource whose list refuses a limit with RC5059 and whose describe throws a plain error
   * @expectedResult The RC5059 is a 400 carrying the message, since it is the caller's; the plain error is a 500 carrying "resource failed" and the resource name with no message, and the server stays up to answer the next request
   */
  test("a throwing resource is a 500 and a bad page is a 400", async () => {
    const port = await start({
      introspection: true,
      plugins: [
        contributing({
          name: "widgets",
          list: async (query) => {
            if (query["limit"] !== undefined) {
              throw rcError("RC5059", undefined, {
                message: "The page limit must be a positive integer.",
              });
            }
            return { items: [] };
          },
          describe: async () => {
            throw new Error("the store is on fire: /var/lib/secret.db");
          },
        }),
      ],
    });
    const bad = await call<{ error: string; message: string }>(
      port,
      "/ops/widgets?limit=x",
    );
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("positive integer");
    const boom = await call<{ error: string; resource: string; code?: string }>(
      port,
      "/ops/widgets/a",
    );
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({
      error: "resource failed",
      resource: "widgets",
    });
    expect(JSON.stringify(boom.body)).not.toContain("secret.db");
    expect((await call(port, "/ops/widgets")).status).toBe(200);
  });

  /**
   * @case A contributed collection reads the page query as the route listing does, and a HEAD costs the contributor nothing
   * @preconditions A widgets resource whose list counts its calls, an ops mount with the introspection tier open
   * @expectedResult ?limit=2e1 and ?limit=1.0 are accepted as the route listing accepts them, a HEAD on the collection answers 200 with no body and without calling list, and a non-string resource name is RC5053
   */
  test("shares the page query contract and answers HEAD cheaply", async () => {
    let lists = 0;
    const port = await start({
      introspection: true,
      plugins: [
        contributing({
          name: "widgets",
          list: async (query) => {
            lists += 1;
            return { items: [], ...parsePageQuery(query) };
          },
          describe: async () => undefined,
        }),
      ],
    });
    expect((await call(port, "/ops/widgets?limit=2e1")).status).toBe(200);
    expect((await call(port, "/ops/widgets?limit=1.0")).status).toBe(200);
    expect((await call(port, "/ops/widgets?limit=0")).status).toBe(400);
    lists = 0;
    const head = await call(port, "/ops/widgets", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    expect(lists).toBe(0);
    await expect(
      testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [
            contributing({
              ...widgets([]),
              name: undefined as unknown as string,
            }),
          ],
        })
        .routes([craft().id("worker").from(direct()).to(noop())])
        .build(),
    ).rejects.toMatchObject({ rc: "RC5053" });
  });

  /**
   * @case A reserved, malformed or duplicate resource name is refused at registration
   * @preconditions Contributors registering "routes", "Bad Name", and "widgets" twice
   * @expectedResult Each build fails with RC5053 naming the problem, before any server binds
   */
  test("refuses reserved, malformed and duplicate names", async () => {
    const build = (plugins: CraftPlugin[]) =>
      testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [...plugins, opsPlugin({ tiers: { introspection: true } })],
        })
        .routes([craft().id("worker").from(direct()).to(noop())])
        .build();
    await expect(
      build([contributing({ ...widgets([]), name: "routes" })]),
    ).rejects.toMatchObject({ rc: "RC5053" });
    await expect(
      build([contributing({ ...widgets([]), name: "Bad Name" })]),
    ).rejects.toMatchObject({ rc: "RC5053" });
    await expect(
      build([contributing(widgets([])), contributing(widgets([]))]),
    ).rejects.toMatchObject({ rc: "RC5053" });
  });
});
