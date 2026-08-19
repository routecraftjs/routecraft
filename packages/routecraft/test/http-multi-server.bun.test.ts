import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  http,
  httpPlugin,
  noop,
  type CraftConfig,
  type EventName,
} from "@routecraft/routecraft";

/**
 * Per-mount server selection: one http plugin whose mounts sit on different
 * listeners. The listener is a mount property, so these tests pin the three
 * facts that make that safe: dispatch stays on the mount's own socket, the
 * early duplicate-path refusal is scoped per server, and the builtins never
 * describe another listener's routes.
 */
describe("http mounts across named servers", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /** Boot two listeners and return their ports keyed by server name. */
  async function bootTwoServers(
    mounts: NonNullable<Parameters<typeof httpPlugin>[0]["mounts"]>,
    routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
  ): Promise<Record<string, number>> {
    const ports: Record<string, number> = {};
    const builder = testContext()
      .on(
        "server:listening" as EventName,
        ((payload: { details: unknown }) => {
          const { server, port } = payload.details as {
            server: string;
            port: number;
          };
          ports[server] = port;
        }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
      )
      .routes(routes)
      .with({
        servers: {
          default: { port: 0, host: "127.0.0.1" },
          internal: { port: 0, host: "127.0.0.1" },
        },
        http: { mounts },
      } as CraftConfig);
    t = await builder.build();
    await t.startAndWaitReady();
    expect(Object.keys(ports).sort()).toEqual(["default", "internal"]);
    return ports;
  }

  /**
   * @case Each mount dispatches on its own listener only
   * @preconditions One plugin with a default-root mount on servers.default and an admin mount on servers.internal
   * @expectedResult Each route answers on its mount's socket and the other socket has never heard of it
   */
  test("routes answer on their mount's listener and nowhere else", async () => {
    const ports = await bootTwoServers(
      {
        default: { path: "/" },
        admin: { path: "/admin", server: "internal" },
      },
      [
        craft()
          .id("hello")
          .from(http({ path: "/hello", method: "GET" }))
          .transform(() => ({ from: "public" }))
          .to(noop()),
        craft()
          .id("admin-hello")
          .from(http({ mount: "admin", path: "/hello", method: "GET" }))
          .transform(() => ({ from: "internal" }))
          .to(noop()),
      ],
    );

    const publicHello = await fetch(
      `http://127.0.0.1:${ports["default"]}/hello`,
    );
    expect(await publicHello.json()).toEqual({ from: "public" });

    const internalHello = await fetch(
      `http://127.0.0.1:${ports["internal"]}/admin/hello`,
    );
    expect(await internalHello.json()).toEqual({ from: "internal" });

    const crossed = await fetch(
      `http://127.0.0.1:${ports["default"]}/admin/hello`,
    );
    expect(crossed.status).toBe(404);
  });

  /**
   * @case Builtins describe only their own listener's routes
   * @preconditions Default-root mount on servers.default, admin mount on servers.internal, one route on each
   * @expectedResult /openapi.json on the public listener documents the public route and not the internal one. Aggregating across listeners would publish the internal inventory through the public document, defeating the point of a second listener
   */
  test("openapi on the public listener omits the internal listener's routes", async () => {
    const ports = await bootTwoServers(
      {
        default: { path: "/" },
        admin: { path: "/admin", server: "internal" },
      },
      [
        craft()
          .id("public-route")
          .from(http({ path: "/orders", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
        craft()
          .id("internal-route")
          .from(http({ mount: "admin", path: "/secrets", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      ],
    );

    const res = await fetch(
      `http://127.0.0.1:${ports["default"]}/openapi.json`,
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(doc.paths);
    expect(paths).toContain("/orders");
    expect(paths.every((path) => !path.includes("secrets"))).toBe(true);
  });

  /**
   * @case The same path is legal on two listeners and refused on one
   * @preconditions Two mounts at "/api" on different servers; then two mounts at "/api" on the same server
   * @expectedResult The cross-listener pair constructs, the same-listener pair is refused naming both mounts and the server
   */
  test("duplicate mount paths are scoped per server", () => {
    expect(() =>
      httpPlugin({
        mounts: {
          api: { path: "/api" },
          mirror: { path: "/api", server: "internal" },
        },
      }),
    ).not.toThrow();

    expect(() =>
      httpPlugin({
        mounts: {
          api: { path: "/api" },
          mirror: { path: "/api" },
        },
      }),
    ).toThrow(/both claim path "\/api" on servers\.default/);
  });

  /**
   * @case Top-level server does not combine with mounts
   * @preconditions httpPlugin({ server, mounts })
   * @expectedResult Refused. The top level is the single-mount shorthand; with mounts, each mount names its own server, so a plugin-level value would be the same fact at two levels
   */
  test("refuses top-level server alongside mounts", () => {
    expect(() =>
      httpPlugin({
        server: "internal",
        mounts: { api: { path: "/api" } },
      }),
    ).toThrow(/`server` and `mounts` are mutually exclusive/);
  });
});
