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
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("public", context);
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
  test("detects late dynamic route conflicts", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("public", context);
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
  test("rejects mountless servers", async () => {
    const context = (await testContext().build()).ctx;
    expect(() => new HttpMountRegistry("empty", context).validate()).toThrow(
      /no mounts/,
    );
  });

  /**
   * @case Server authentication is inherited and evaluated once
   * @preconditions A named server validator and a mount with no auth override
   * @expectedResult The handler receives the admitted principal and the verifier runs once
   */
  test("inherits server auth and verifies each request once", async () => {
    const context = (await testContext().build()).ctx;
    let calls = 0;
    const ingress = new HttpMountRegistry("secure", context, {
      validator: (token) => {
        calls++;
        return { kind: "custom", scheme: "bearer", subject: token };
      },
    });
    ingress.mountHttp({
      id: "surface",
      claims: () => [{ kind: "exact", path: "/private" }],
      handler: (_request, mount) =>
        Response.json({
          subject:
            mount.auth?.kind === "admit"
              ? mount.auth.principal.subject
              : undefined,
        }),
    });
    ingress.validate();

    const response = await ingress.dispatch(
      new Request("http://local/private", {
        headers: { authorization: "Bearer alice" },
      }),
    );
    expect(await response.json()).toEqual({ subject: "alice" });
    expect(calls).toBe(1);
  });

  /**
   * @case A mount explicitly disables inherited server authentication
   * @preconditions A secured server and a mount configured with auth false
   * @expectedResult The public mount runs without invoking the server verifier
   */
  test("supports auth false as a mount override", async () => {
    const context = (await testContext().build()).ctx;
    let calls = 0;
    const ingress = new HttpMountRegistry("secure", context, {
      validator: () => {
        calls++;
        return { kind: "custom", scheme: "bearer", subject: "unexpected" };
      },
    });
    ingress.mountHttp({
      id: "public",
      auth: false,
      claims: () => [{ kind: "exact", path: "/public" }],
      handler: (_request, mount) =>
        Response.json({ authenticated: mount.auth !== undefined }),
    });
    ingress.validate();

    expect(
      await (await ingress.dispatch(new Request("http://local/public"))).json(),
    ).toEqual({ authenticated: false });
    expect(calls).toBe(0);
  });

  /**
   * @case Shared auth classifies nested verifier network failures as infrastructure
   * @preconditions Server validator throws a fetch-style error whose cause is ECONNREFUSED
   * @expectedResult The bounded auth:rejected reason is infrastructure rather than invalid_token
   */
  test("classifies nested verifier network failures consistently", async () => {
    const built = await testContext().build();
    const rejections: Array<Record<string, unknown>> = [];
    built.ctx.on("auth:rejected", ({ details }) => {
      rejections.push(details as Record<string, unknown>);
    });
    const ingress = new HttpMountRegistry("secure", built.ctx, {
      validator: () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        });
      },
    });
    ingress.mountHttp({
      id: "surface",
      claims: () => [{ kind: "exact", path: "/private" }],
      handler: () => new Response("unreachable"),
    });
    ingress.validate();

    await ingress.dispatch(
      new Request("http://local/private", {
        headers: { authorization: "Bearer token" },
      }),
    );
    expect(rejections).toContainEqual({
      reason: "infrastructure",
      scheme: "bearer",
      source: "surface",
    });
  });

  /**
   * @case Claim thunks become immutable routing input after validation
   * @preconditions A mount whose claim-producing state changes after validate
   * @expectedResult Dispatch uses the claims evaluated during validation only
   */
  test("evaluates claim thunks once at bind validation", async () => {
    const context = (await testContext().build()).ctx;
    let path = "/before";
    let evaluations = 0;
    const ingress = new HttpMountRegistry("stable", context);
    ingress.mountHttp({
      id: "stable",
      claims: () => {
        evaluations++;
        return [{ kind: "exact", path }];
      },
      handler: () => new Response("mounted"),
    });
    ingress.validate();
    path = "/after";

    expect(
      (await ingress.dispatch(new Request("http://local/before"))).status,
    ).toBe(200);
    expect(
      (await ingress.dispatch(new Request("http://local/after"))).status,
    ).toBe(404);
    expect(evaluations).toBe(1);
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
