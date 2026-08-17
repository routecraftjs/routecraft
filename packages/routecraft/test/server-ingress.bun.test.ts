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
      handler: async (_request, mount) => {
        // Two pulls on the thunk must still verify once: memoized per request.
        const auth = await mount.authenticate();
        await mount.authenticate();
        return Response.json({
          subject: auth?.kind === "admit" ? auth.principal.subject : undefined,
        });
      },
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
      handler: async (_request, mount) =>
        Response.json({
          authenticated: (await mount.authenticate()) !== undefined,
        }),
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
      handler: async (_request, mount) => {
        const auth = await mount.authenticate();
        return auth?.kind === "reject"
          ? auth.response
          : new Response("unreachable");
      },
    });
    ingress.validate();

    const response = await ingress.dispatch(
      new Request("http://local/private", {
        headers: { authorization: "Bearer token" },
      }),
    );
    expect(response.status).toBe(500);
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

  /**
   * @case A route on a public mount never triggers the shared validator
   * @preconditions Server-level validator; http mount opts out with auth false; a garbage bearer presented
   * @expectedResult The route serves normally, the validator is never invoked, and no auth event fires
   */
  test("public mount routes never trigger the shared validator", async () => {
    let validatorCalls = 0;
    const authEvents: string[] = [];
    let port = 0;
    const t = await testContext()
      .on(
        "server:listening" as EventName,
        ((event: { details: { port: number } }) => {
          port = event.details.port;
        }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
      )
      .with({
        servers: {
          default: {
            host: "127.0.0.1",
            port: 0,
            auth: {
              validator: () => {
                validatorCalls++;
                throw new Error("must never run for a public-mount route");
              },
            },
          },
        },
        http: { auth: false },
      })
      .routes([
        craft()
          .id("public-feed")
          .from(http({ path: "/feed" }))
          .to(noop()),
      ])
      .build();
    t.ctx.on("auth:success", () => {
      authEvents.push("success");
    });
    t.ctx.on("auth:rejected", () => {
      authEvents.push("rejected");
    });

    try {
      await t.startAndWaitReady();
      const res = await fetch(`http://127.0.0.1:${port}/feed`, {
        headers: {
          Authorization: "Bearer totally-fabricated",
          Connection: "close",
        },
      });
      expect(res.status).toBe(204);
      expect(validatorCalls).toBe(0);
      expect(authEvents).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  /**
   * @case Unmounting removes the surface from dispatch immediately
   * @preconditions A validated ingress with one mount whose disposer has run
   * @expectedResult Requests to the unmounted path get the ingress 404, not the stale handler
   */
  test("unmount prunes the evaluated dispatch state", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("draining", context);
    const unmount = ingress.mountHttp({
      id: "surface",
      claims: () => [{ kind: "exact", path: "/gone" }],
      handler: () => new Response("alive"),
    });
    ingress.validate();
    expect(
      (await ingress.dispatch(new Request("http://local/gone"))).status,
    ).toBe(200);

    unmount();
    expect(
      (await ingress.dispatch(new Request("http://local/gone"))).status,
    ).toBe(404);
  });

  /**
   * @case Long-lived mounts exempt their requests from the idle timeout
   * @preconditions One longLived mount and one ordinary mount on a validated registry
   * @expectedResult Dispatch invokes the runtime exemption only for the longLived mount
   */
  test("longLived mounts pull the per-request idle exemption", async () => {
    const context = (await testContext().build()).ctx;
    const exempted: string[] = [];
    const runtime = {
      exemptFromIdleTimeout: (req: Request) => {
        exempted.push(new URL(req.url).pathname);
      },
    };
    const ingress = new HttpMountRegistry("streams", context);
    ingress.mountHttp({
      id: "mcp",
      longLived: true,
      claims: () => [{ kind: "exact", path: "/mcp" }],
      handler: () => new Response("stream"),
    });
    ingress.mountHttp({
      id: "plain",
      claims: () => [{ kind: "exact", path: "/plain" }],
      handler: () => new Response("plain"),
    });
    ingress.validate();

    await ingress.dispatch(new Request("http://local/mcp"), runtime);
    await ingress.dispatch(new Request("http://local/plain"), runtime);
    expect(exempted).toEqual(["/mcp"]);
  });

  /**
   * @case Two mounts both claiming the "/" catch-all are refused
   * @preconditions Two mounts whose claims each include the prefix "/" fallback
   * @expectedResult Validation fails naming both mounts instead of shadowing by registration order
   */
  test("rejects a second catch-all fallback mount", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("shadowed", context);
    ingress.mountHttp({
      id: "first",
      claims: () => [{ kind: "prefix", path: "/" }],
      handler: () => new Response("first"),
    });
    ingress.mountHttp({
      id: "second",
      claims: () => [{ kind: "prefix", path: "/" }],
      handler: () => new Response("second"),
    });
    expect(() => ingress.validate()).toThrow(/catch-all/);
  });

  /**
   * @case A mount registered after validation is refused
   * @preconditions A registry whose claims were already evaluated at start
   * @expectedResult mountHttp throws instead of accepting a mount that would never dispatch
   */
  test("rejects mounts registered after validation", async () => {
    const context = (await testContext().build()).ctx;
    const ingress = new HttpMountRegistry("late", context);
    ingress.mountHttp({
      id: "early",
      claims: () => [{ kind: "exact", path: "/early" }],
      handler: () => new Response("early"),
    });
    ingress.validate();
    expect(() =>
      ingress.mountHttp({
        id: "late",
        claims: () => [{ kind: "exact", path: "/late" }],
        handler: () => new Response("late"),
      }),
    ).toThrow(/after the server validated/);
  });
});
