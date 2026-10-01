import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  noop,
  rcError,
  type AnyRouteBuilder,
  type Principal,
} from "@routecraft/routecraft";
import { z } from "zod";
import { McpServer } from "../src/mcp/server.ts";
import { mcp, mcpPlugin } from "../src/index.ts";
import { MCP_PLUGIN_REGISTERED } from "../src/mcp/types.ts";
import { rpcBody } from "./fixtures/rpc-body.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

const INIT_PARAMS = {
  protocolVersion: "2024-11-05" as const,
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

/** A hostname and a path, the kind of detail a failing adapter interpolates. */
const SECRET_HOST = "db-primary.internal.corp:5432";
const SECRET_PATH = "/var/lib/app/secrets/token.json";

/**
 * What a failed local tool call puts on the MCP wire. The code crosses the
 * wire and the message does not; a failure the caller caused on the tool's
 * own route keeps an answer an agent can act on.
 */
describe("MCP tool failure text", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    await t?.stop();
    t = undefined;
  });

  async function serve(routes: AnyRouteBuilder[]): Promise<McpServer> {
    t = await testContext().routes(routes).store(MCP_STORE_KEY, true).build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);
    return server;
  }

  function user(overrides: Partial<Principal> = {}): Principal {
    return {
      kind: "custom",
      scheme: "bearer",
      subject: "user-7",
      ...overrides,
    } as Principal;
  }

  /**
   * @case A step throws a plain Error whose message names a host and a path
   * @preconditions Tool route whose transform throws new Error naming an internal hostname and a file path; the pipeline wraps it as RC5001
   * @expectedResult The result text is exactly the tool name and RC5001, with neither the host nor the path; the failed event and the error log still carry the message for the operator
   */
  test("withholds a step error's message and keeps it for the operator", async () => {
    const srv = await serve([
      craft()
        .id("thrower")
        .description("Throws an error naming internals")
        .from<{ value: string }>(mcp())
        .transform(() => {
          throw new Error(
            `connect ECONNREFUSED ${SECRET_HOST} reading ${SECRET_PATH}`,
          );
        }),
    ]);
    const failed: Array<Record<string, unknown>> = [];
    t!.ctx.on("plugin:mcp:tool:failed", (payload) => {
      failed.push(payload.details as Record<string, unknown>);
    });

    const result = await callTool(srv, "thrower", { value: "hi" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'Error: Tool "thrower" failed (RC5001).',
    );
    expect(JSON.stringify(result)).not.toContain(SECRET_HOST);
    expect(JSON.stringify(result)).not.toContain(SECRET_PATH);
    expect(String(failed[0]!["error"])).toContain(SECRET_HOST);
  });

  /**
   * @case A RoutecraftError whose message and cause both carry internals
   * @preconditions Tool route throws rcError("RC5003", cause naming a path, { message naming a host })
   * @expectedResult Only the tool name and RC5003 reach the caller; neither the message nor the cause does
   */
  test("withholds an RC error's message and its cause", async () => {
    const srv = await serve([
      craft()
        .id("adapter-failure")
        .description("Throws an adapter-shaped RC error")
        .from<{ value: string }>(mcp())
        .transform(() => {
          throw rcError("RC5003", new Error(`ENOENT ${SECRET_PATH}`), {
            message: `Upstream ${SECRET_HOST} refused the call`,
          });
        }),
    ]);

    const result = await callTool(srv, "adapter-failure", { value: "hi" });

    expect(result.content[0]!.text).toBe(
      'Error: Tool "adapter-failure" failed (RC5003).',
    );
  });

  /**
   * @case The tool's own .input() schema refuses the arguments
   * @preconditions Tool route declares .input({ body }) with a required non-empty query and a numeric limit; called with an empty query and a string limit
   * @expectedResult RC5065 with each issue's path and message, so the agent can correct the call, and without the RC message that names the route
   */
  test("answers an input refusal with the schema issues", async () => {
    const srv = await serve([
      craft()
        .id("search")
        .description("Search with a validated query")
        .input({
          body: z.object({ query: z.string().min(1), limit: z.number() }),
        })
        .from(mcp())
        .to(noop()),
    ]);

    const result = await callTool(srv, "search", { query: "", limit: "ten" });

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toStartWith(
      'Error: Tool "search" rejected its arguments (RC5065): ',
    );
    expect(text).toContain('"query": ');
    expect(text).toContain('"limit": ');
    expect(text).not.toContain("validation failed for route");
  });

  /**
   * @case An input refusal with more issues than the wire carries
   * @preconditions Tool route's .input() requires an array of 25 numbers; called with 25 strings
   * @expectedResult The text lists 20 issues and ends by counting the 5 it left out
   */
  test("caps the issues an input refusal lists", async () => {
    const srv = await serve([
      craft()
        .id("bulk")
        .description("Takes many numbers")
        .input({ body: z.object({ items: z.array(z.number()) }) })
        .from(mcp())
        .to(noop()),
    ]);

    const result = await callTool(srv, "bulk", {
      items: Array.from({ length: 25 }, () => "x"),
    });

    const text = result.content[0]!.text;
    expect(text.match(/"items\.\d+":/g)).toHaveLength(20);
    expect(text).toEndWith("; and 5 more");
  });

  /**
   * @case A route the tool calls through direct() refuses its input
   * @preconditions Tool route with no .input() forwards to a direct route whose .input() rejects the forwarded body
   * @expectedResult The generic failure text with RC5065: what the inner route refused is the tool's own output, not anything the caller sent, so no issues and no inner route id reach the wire
   */
  test("does not attribute a nested route's input refusal to the caller", async () => {
    const srv = await serve([
      craft()
        .id("outer")
        .description("Forwards to an internal route")
        .from<{ value: string }>(mcp())
        .to(direct("inner-strict")),
      craft()
        .id("inner-strict")
        .input({ body: z.object({ count: z.number() }) })
        .from(direct())
        .to(noop()),
    ]);

    const result = await callTool(srv, "outer", { value: "hi" });

    expect(result.content[0]!.text).toBe(
      'Error: Tool "outer" failed (RC5065).',
    );
  });

  /**
   * @case The tool's own .authorize() refuses the admitted principal's roles
   * @preconditions Tool route declares .authorize({ roles: ["admin"] }); called with a principal carrying no roles
   * @expectedResult The fixed insufficient-permissions text, with neither the RC message nor the roles the route requires
   */
  test("answers a role refusal with the permissions class", async () => {
    const srv = await serve([
      craft()
        .id("archive")
        .description("Admins only")
        .authorize({ roles: ["admin"] })
        .from(mcp())
        .to(noop()),
    ]);

    const result = await callTool(srv, "archive", {}, user());

    expect(result.content[0]!.text).toBe(
      'Error: Tool "archive" refused the call: insufficient permissions.',
    );
  });

  /**
   * @case A caller refusal and an instance fault log at different levels
   * @preconditions One tool whose .authorize() refuses the caller, one whose step throws; both called once
   * @expectedResult The refusal's tool line is debug and never error, the fault's is error, matching the http doors
   */
  test("logs a caller refusal at debug and a fault at error", async () => {
    const srv = await serve([
      craft()
        .id("archive")
        .description("Admins only")
        .authorize({ roles: ["admin"] })
        .from(mcp())
        .to(noop()),
      craft()
        .id("thrower")
        .description("Fails")
        .from(mcp())
        .transform(() => {
          throw new Error("boom");
        }),
    ]);
    const toolLines = (calls: unknown[][], tool: string) =>
      calls.filter(
        ([bindings]) =>
          (bindings as { tool?: string } | undefined)?.tool === tool,
      );

    await callTool(srv, "archive", {}, user());
    await callTool(srv, "thrower", {});

    const log = t!.contextLogger;
    expect(toolLines(log.debug.mock.calls, "archive")).toHaveLength(1);
    expect(toolLines(log.error.mock.calls, "archive")).toHaveLength(0);
    expect(toolLines(log.error.mock.calls, "thrower")).toHaveLength(1);
  });

  /**
   * @case The tool's own .authorize() refuses for a missing scope
   * @preconditions Tool route declares .authorize({ scopes: ["orders:write"] }); principal carries only orders:read
   * @expectedResult The insufficient-scope text naming the missing scope, so the agent can request it
   */
  test("answers a scope refusal naming the missing scopes", async () => {
    const srv = await serve([
      craft()
        .id("write-order")
        .description("Needs a write scope")
        .authorize({ scopes: ["orders:write"] })
        .from(mcp())
        .to(noop()),
    ]);

    const result = await callTool(
      srv,
      "write-order",
      {},
      user({ scopes: ["orders:read"] }),
    );

    expect(result.content[0]!.text).toBe(
      'Error: Tool "write-order" refused the call: insufficient scope, missing: orders:write.',
    );
  });

  /**
   * @case The admitted credential expired before the tool's .authorize() ran
   * @preconditions Tool route declares .authorize(); principal's expiresAt is an hour in the past
   * @expectedResult The expired text telling the agent to refresh, not the generic failure
   */
  test("answers an expired credential with the expired class", async () => {
    const srv = await serve([
      craft()
        .id("guarded")
        .description("Any authenticated caller")
        .authorize()
        .from(mcp())
        .to(noop()),
    ]);

    const result = await callTool(
      srv,
      "guarded",
      {},
      user({ expiresAt: Math.floor(Date.now() / 1000) - 3600 }),
    );

    expect(result.content[0]!.text).toBe(
      'Error: Tool "guarded" refused the call: the credential expired. Refresh it and retry.',
    );
  });

  /**
   * @case A step throws an authorization code that authorize() did not raise
   * @preconditions Tool route's transform throws rcError("RC5015") the way an adapter reports an upstream login refused; caller has a principal
   * @expectedResult The generic failure text with RC5015: the code alone does not make it the caller's refusal
   */
  test("does not map an authorization code by code alone", async () => {
    const srv = await serve([
      craft()
        .id("upstream-login")
        .description("Upstream refuses the instance's own login")
        .from(mcp())
        .transform(() => {
          throw rcError("RC5015", undefined, {
            message: `IMAP login refused by ${SECRET_HOST}`,
          });
        }),
    ]);

    const result = await callTool(srv, "upstream-login", {}, user());

    expect(result.content[0]!.text).toBe(
      'Error: Tool "upstream-login" failed (RC5015).',
    );
  });

  /**
   * @case The route's own .output() rejects the result it produced
   * @preconditions Tool route declares .output({ body }) requiring a numeric total and transforms to a string total
   * @expectedResult The output-schema text naming the failing field and RC5002, without the RC message that names the route
   */
  test("names the failing fields of an output violation without the route", async () => {
    const srv = await serve([
      craft()
        .id("violator")
        .description("Returns a body its output schema rejects")
        .output({ body: z.object({ total: z.number() }) })
        .from<{ value: string }>(mcp())
        .transform(() => ({ total: "lots" })),
    ]);

    const result = await callTool(srv, "violator", { value: "hi" });

    const text = result.content[0]!.text;
    expect(text).toStartWith(
      'Error: MCP tool "violator" returned a body that does not match its declared output schema (RC5002): "total": ',
    );
    expect(text).not.toContain("for route");
  });

  /**
   * @case The route's .output() headers schema rejects the headers it produced
   * @preconditions Tool route declares .output({ headers }) requiring an internal header the route never sets; the headers schema is not part of the advertised outputSchema
   * @expectedResult The generic failure text with RC5002, naming neither the header nor the schema's message
   */
  test("keeps an output headers violation generic", async () => {
    const srv = await serve([
      craft()
        .id("tagged")
        .description("Produces headers its output schema rejects")
        .output({ headers: z.object({ "x-internal-tenant": z.string() }) })
        .from<{ value: string }>(mcp())
        .transform(() => ({ ok: true })),
    ]);

    const result = await callTool(srv, "tagged", { value: "hi" });

    expect(result.content[0]!.text).toBe(
      'Error: Tool "tagged" failed (RC5002).',
    );
  });
});

/**
 * A missing principal is the caller's to fix only where a credential could
 * have supplied one: an HTTP mount with a validator that served the call
 * anonymously.
 */
describe("MCP tool failure text over HTTP", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  async function boot(
    validator: boolean,
  ): Promise<(token?: string) => Promise<string>> {
    let port = 0;
    t = await testContext()
      .on("server:listening", ({ details }) => {
        port = details.port;
      })
      .routes([
        craft()
          .id("admin-only")
          .description("Admins only")
          .authorize({ roles: ["admin"] })
          .from(mcp())
          .to(noop()),
      ])
      .with({
        servers: {
          default: {
            host: "127.0.0.1",
            port: 0,
            ...(validator
              ? {
                  auth: {
                    validator: (token: string) => {
                      if (token !== "good-token") throw new Error("bad token");
                      return {
                        kind: "custom" as const,
                        scheme: "bearer" as const,
                        subject: "user-7",
                      };
                    },
                  },
                }
              : {}),
          },
        },
        plugins: [mcpPlugin({ transport: "http", auth: false })],
      })
      .build();
    await t.startAndWaitReady();

    async function post(body: unknown, token?: string): Promise<string> {
      const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return rpcBody(await res.text());
    }

    return async (token?: string) => {
      await post(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS },
        token,
      );
      const raw = await post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "admin-only", arguments: {} },
        },
        token,
      );
      const parsed = JSON.parse(raw) as {
        result: { content: Array<{ text: string }> };
      };
      return parsed.result.content[0]!.text;
    };
  }

  /**
   * @case An anonymous caller on an opted-out mount whose server has a validator
   * @preconditions mcp auth false over a server validator; the tool's .authorize() finds no principal (RC5012)
   * @expectedResult The unauthenticated text, because presenting a credential would have changed the outcome
   */
  test("tells an anonymous caller to authenticate when it could have", async () => {
    const call = await boot(true);
    expect(await call()).toBe(
      'Error: Tool "admin-only" requires an authenticated caller. Connect with a credential and retry.',
    );
  });

  /**
   * @case A caller authenticated through the HTTP transport lacks the role
   * @preconditions Same mount; the bearer is admitted as a principal with no roles
   * @expectedResult The insufficient-permissions text, proving the principal the transport admitted is the one the refusal is matched against
   */
  test("maps a refusal of the principal the transport admitted", async () => {
    const call = await boot(true);
    expect(await call("good-token")).toBe(
      'Error: Tool "admin-only" refused the call: insufficient permissions.',
    );
  });

  /**
   * @case An anonymous caller where no validator exists
   * @preconditions mcp auth false and no server validator; the tool's .authorize() finds no principal (RC5012)
   * @expectedResult The generic failure text with RC5012: no credential could have helped, so the failure is the instance's
   */
  test("keeps a missing principal generic when no credential could help", async () => {
    const call = await boot(false);
    expect(await call()).toBe('Error: Tool "admin-only" failed (RC5012).');
  });
});
