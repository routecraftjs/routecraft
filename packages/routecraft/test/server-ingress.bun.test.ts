import { describe, expect, test } from "bun:test";
import { testContext } from "@routecraft/testing";
import {
  craft,
  http,
  noop,
  requireWebIngress,
  type CraftPlugin,
  type EventName,
} from "../src/index.ts";
import {
  compilePathMatcher,
  staticPathPrefix,
} from "../src/plugins/http/path-matcher.ts";
import { HttpMountRegistry } from "../src/plugins/server/registry.ts";

/**
 * Named server ingress owns cross-surface routing and validation.
 */
describe("named server ingress", () => {
  /**
   * @case Exact mounts share a listener with the HTTP fallback
   * @preconditions A catch-all HTTP mount and an exact MCP mount
   * @expectedResult Exact dispatch wins while unrelated paths reach HTTP
   */
  test("dispatches exact mounts ahead of the HTTP fallback", async () => {
    const ingress = new HttpMountRegistry("public");
    ingress.mountHttp({
      id: "http",
      claims: () => [{ kind: "prefix", path: "/" }],
      handler: () => new Response("http"),
    });
    ingress.mountHttp({
      id: "mcp",
      claims: () => [{ kind: "exact", path: "/mcp", methods: ["POST"] }],
      handler: () => new Response("mcp"),
    });

    ingress.validate();
    expect(
      await (
        await ingress.dispatch(
          new Request("http://local/mcp", { method: "POST" }),
        )
      ).text(),
    ).toBe("mcp");
    expect(
      await (await ingress.dispatch(new Request("http://local/health"))).text(),
    ).toBe("http");
  });

  /**
   * @case Claims are evaluated during start validation
   * @preconditions A dynamic HTTP route registered after mounting overlaps MCP
   * @expectedResult Validation fails before the listener binds
   */
  test("detects late dynamic route conflicts", () => {
    const ingress = new HttpMountRegistry("public");
    const routes = [compilePathMatcher("/status/:id")];
    ingress.mountHttp({
      id: "http",
      claims: () => [
        { kind: "prefix", path: "/" },
        ...routes.map((matcher) => ({
          kind: "pattern" as const,
          matcher,
          staticPrefix: staticPathPrefix(matcher.pattern),
          methods: ["GET" as const],
        })),
      ],
      handler: () => new Response("http"),
    });
    ingress.mountHttp({
      id: "health",
      claims: () => [{ kind: "exact", path: "/health", methods: ["GET"] }],
      handler: () => new Response("health"),
    });
    routes.push(compilePathMatcher("/health"));

    expect(() => ingress.validate()).toThrow(/conflicts/);
  });

  /**
   * @case A named listener has no mounted surface
   * @preconditions An empty ingress registry
   * @expectedResult Validation refuses a useless listener
   */
  test("rejects mountless servers", () => {
    expect(() => new HttpMountRegistry("empty").validate()).toThrow(
      /no mounts/,
    );
  });

  /**
   * @case HTTP and a custom plugin use one named listener
   * @preconditions One ephemeral named server with both surfaces mounted
   * @expectedResult Both paths respond on the emitted listener port
   */
  test("serves HTTP and custom plugin paths on one port", async () => {
    let port = 0;
    const custom: CraftPlugin = {
      name: "custom-health",
      apply(ctx) {
        const unmount = requireWebIngress(ctx, "public").mountHttp({
          id: "custom-health",
          claims: () => [
            { kind: "exact", path: "/internal/health", methods: ["GET"] },
          ],
          handler: () => Response.json({ custom: true }),
        });
        ctx.registerTeardown(unmount);
      },
    };
    const t = await testContext()
      .on(
        "server:listening" as EventName,
        ((event: { details: { port: number } }) => {
          port = event.details.port;
        }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
      )
      .with({
        servers: { public: { port: 0 } },
        http: { server: "public" },
        plugins: [custom],
      })
      .routes([
        craft()
          .id("http-holder")
          .from(http({ path: "/api" }))
          .to(noop()),
      ])
      .build();

    try {
      await t.startAndWaitReady();
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      expect(
        await (await fetch(`http://127.0.0.1:${port}/internal/health`)).json(),
      ).toEqual({ custom: true });
    } finally {
      await t.stop();
    }
  });
});
