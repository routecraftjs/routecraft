import { describe, test, expect, afterEach } from "vitest";
import { McpServer } from "../src/mcp/server.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop } from "@routecraft/routecraft";
import { mcp, MCP_PLUGIN_REGISTERED } from "../src/index.ts";
import { buildAuthHeaders } from "../src/mcp/build-auth-headers.ts";
import { z } from "zod";
import http from "node:http";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

/** Shared JSON-RPC params for MCP tests. */
const INIT_PARAMS = {
  protocolVersion: "2024-11-05" as const,
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

describe("McpServer", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore
      }
    }
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case McpServer construction with default and custom options
   * @preconditions Context built; create server with no options then with name/version
   * @expectedResult Both servers are defined
   */
  test("initializes with default and custom options", async () => {
    t = await testContext().build();
    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await server.stop();
    server = new McpServer(t.ctx, {
      name: "custom-server",
      version: "2.0.0",
    });
    expect(server).toBeDefined();
  });

  /**
   * @case Tool filtering by name array and by predicate
   * @preconditions Routes for tool1, tool2, public-tool, private-tool; filter by name then by keywords
   * @expectedResult Only allowed tools appear in getAvailableTools()
   */
  test("respects tool filtering by name and by function", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("tool1")
          .from(mcp("tool1", { description: "First tool" }))
          .to(noop()),
        craft()
          .id("tool2")
          .from(mcp("tool2", { description: "Second tool" }))
          .to(noop()),
        craft()
          .id("public-tool")
          .from(
            mcp("public-tool", {
              description: "Public",
              keywords: ["public"],
            }),
          )
          .to(noop()),
        craft()
          .id("private-tool")
          .from(
            mcp("private-tool", {
              description: "Private",
              keywords: ["private"],
            }),
          )
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();

    server = new McpServer(t.ctx, { tools: ["tool1"] });
    expect(server).toBeDefined();
    await t.test();
    let names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["tool1"]);
    await server.stop();

    server = new McpServer(t.ctx, {
      tools: (meta) => meta.keywords?.includes("public") ?? false,
    });
    await server.start();
    names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["public-tool"]);
  });

  /**
   * @case Tools with and without Zod schema are accepted
   * @preconditions One route with Zod schema, one without
   * @expectedResult Server initializes and lists both tools
   */
  test("handles tools with and without schema", async () => {
    const schema = z.object({
      name: z.string().describe("User name"),
      age: z.number().int().min(0),
    });
    t = await testContext()
      .routes([
        craft()
          .id("schema-tool")
          .from(
            mcp("schema-tool", {
              description: "Tool with schema",
              schema,
            }),
          )
          .to(noop()),
        craft()
          .id("no-schema-tool")
          .from(
            mcp("no-schema-tool", {
              description: "Tool without schema",
            }),
          )
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();

    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await t.test();
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toContain("schema-tool");
    expect(names).toContain("no-schema-tool");
  });

  /**
   * @case Only mcp() routes with description are exposed; direct() without description is ignored
   * @preconditions mcp() route with description and direct() route without
   * @expectedResult Only the mcp() tool is in getAvailableTools()
   */
  test("exposes only mcp() routes with description", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("exposed-tool")
          .from(
            mcp("exposed-tool", {
              description: "Exposed",
            }),
          )
          .to(noop()),
        craft()
          .id("internal-direct")
          .from(direct("internal-direct", {}))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await t.test();
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["exposed-tool"]);
  });

  describe("HTTP transport", () => {
    /** Start HTTP server with given route builders; returns post helper and port. Call initSession() to get session id. */
    async function startHttpServer(
      routes: ReturnType<typeof craft>[],
      serverOptions: {
        port?: number;
        host?: string;
        auth?: import("../src/mcp/types.ts").McpHttpAuthOptions;
      } = {},
    ) {
      t = await testContext().routes(routes).store(MCP_STORE_KEY, true).build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
        ...serverOptions,
      });
      const total = t.ctx.getRoutes().length;
      const routesReady =
        total === 0
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              let ready = 0;
              const timeout = setTimeout(
                () => reject(new Error("Timeout waiting for routes")),
                3000,
              );
              t.ctx.on("route:started", () => {
                ready++;
                if (ready >= total) {
                  clearTimeout(timeout);
                  resolve();
                }
              });
            });
      void t.ctx.start();
      await routesReady;
      await server.start();
      const port = server.getHttpPort()!;
      expect(port).toBeDefined();
      expect(Number.isInteger(port) && port > 0).toBe(true);

      function post(
        body: string,
        sessionId?: string,
        extraHeaders?: Record<string, string>,
      ): Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, string | string[] | undefined>;
      }> {
        return new Promise((resolve, reject) => {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          };
          if (sessionId) headers["mcp-session-id"] = sessionId;
          if (extraHeaders) Object.assign(headers, extraHeaders);
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/mcp",
              method: "POST",
              headers,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: data,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >,
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      }

      async function initSession(
        authHeaders?: Record<string, string>,
      ): Promise<string> {
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, authHeaders);
        expect(res.statusCode).toBe(200);
        const sid = res.headers["mcp-session-id"];
        expect(sid).toBeDefined();
        return Array.isArray(sid) ? sid[0] : (sid as string);
      }

      return { post, port, initSession };
    }

    /**
     * @case HTTP server responds to initialize and tools/list
     * @preconditions McpServer http with one mcp() route; initialize then tools/list
     * @expectedResult HTTP 200 and tools array contains the route
     */
    test("listens and responds to POST /mcp tools/list", async () => {
      const { post, initSession } = await startHttpServer([
        craft()
          .id("http-tool")
          .from(
            mcp("http-tool", {
              description: "Tool exposed over HTTP",
            }),
          )
          .to(noop()),
      ]);

      const sessionId = await initSession();
      const listBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const response = await post(listBody, sessionId);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.result).toBeDefined();
      expect(Array.isArray(parsed.result.tools)).toBe(true);
      const toolNames = (parsed.result.tools as { name: string }[]).map(
        (t) => t.name,
      );
      expect(toolNames).toContain("http-tool");
    });

    /**
     * @case tools/call request body is passed into the exchange as an object
     * @preconditions HTTP server with capture route; initialize then tools/call with JSON arguments
     * @expectedResult Exchange body is an object with the argument keys
     */
    test("tools/call passes arguments as object in exchange body", async () => {
      let receivedBody: unknown;
      const { post, initSession } = await startHttpServer([
        craft()
          .id("capture-tool")
          .from(
            mcp("capture-tool", {
              description: "Capture body for test",
              schema: z.object({ user: z.string() }),
            }),
          )
          .tap((ex) => {
            receivedBody = ex.body;
          })
          .to(noop()),
      ]);

      const sessionId = await initSession();
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "capture-tool", arguments: { user: "World" } },
      });
      const callRes = await post(callBody, sessionId);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      expect(typeof receivedBody).toBe("object");
      expect(receivedBody).not.toBeNull();
      expect(receivedBody).toHaveProperty("user", "World");
    });

    /**
     * @case tools/call passes string and object args with correct types
     * @preconditions HTTP server with echo-args route; initialize then tools/call with str and obj
     * @expectedResult Route receives str as string and obj as object (not stringified)
     */
    test("tools/call passes string and object args with correct types", async () => {
      const { post, initSession } = await startHttpServer([
        craft()
          .id("echo-args")
          .from(
            mcp("echo-args", {
              description: "Echo argument types and values for test",
              schema: z.object({
                str: z.string(),
                obj: z.record(z.string(), z.any()),
              }),
            }),
          )
          .transform((body) => ({
            strType: typeof body.str,
            objType: typeof body.obj,
            strVal: body.str,
            objVal: body.obj,
          }))
          .to(noop()),
      ]);

      const sessionId = await initSession();
      const toolArgs = { str: "hello", obj: { a: 1, b: 2 } };
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo-args", arguments: toolArgs },
      });
      const callRes = await post(callBody, sessionId);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      const result = callParsed.result as Record<string, unknown>;
      const content = result?.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content) && content[0]?.text).toBeTruthy();
      const resultText = content[0].text;
      if (resultText.startsWith("Error:")) {
        throw new Error(`Tool call returned error: ${resultText}`);
      }
      const echoed = JSON.parse(resultText) as {
        strType: string;
        objType: string;
        strVal: string;
        objVal: unknown;
      };
      expect(echoed.strType).toBe("string");
      expect(echoed.objType).toBe("object");
      expect(echoed.strVal).toBe("hello");
      expect(echoed.objVal).toEqual({ a: 1, b: 2 });
      expect(typeof echoed.objVal).toBe("object");
      expect(echoed.objVal).not.toBe(null);
    });

    describe("auth", () => {
      /**
       * @case Request without Authorization header returns 401 when auth is configured
       * @preconditions McpServer with auth.tokens set; POST /mcp without Authorization header
       * @expectedResult 401 status code with WWW-Authenticate header
       */
      test("returns 401 when no Authorization header and auth is configured", async () => {
        const { post } = await startHttpServer([], {
          auth: { tokens: "secret-token" },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(401);
        expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
      });

      /**
       * @case Request with wrong token returns 401
       * @preconditions McpServer with auth.tokens = ["valid-token"]; POST /mcp with wrong token
       * @expectedResult 401 status code
       */
      test("returns 401 when wrong token is provided", async () => {
        const { post } = await startHttpServer([], {
          auth: { tokens: "valid-token" },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, {
          Authorization: "Bearer wrong-token",
        });
        expect(res.statusCode).toBe(401);
      });

      /**
       * @case Request with correct single token returns 200
       * @preconditions McpServer with auth.tokens = "valid-token"; POST /mcp with correct bearer token
       * @expectedResult 200 status code and MCP session established
       */
      test("accepts request with correct single token", async () => {
        const { post } = await startHttpServer([], {
          auth: { tokens: "valid-token" },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, {
          Authorization: "Bearer valid-token",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Each token in an array grants access independently
       * @preconditions McpServer with auth.tokens = ["token-a", "token-b"]; two separate requests
       * @expectedResult Both tokens receive 200 status code
       */
      test("accepts any token from an array of tokens", async () => {
        const { post } = await startHttpServer([], {
          auth: { tokens: ["token-a", "token-b"] },
        });

        const resA = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          undefined,
          { Authorization: "Bearer token-a" },
        );
        expect(resA.statusCode).toBe(200);

        // The second initialize is sent to a new session but the SDK may reject
        // the duplicate protocol exchange with 400. What matters is that the auth
        // check passed (not 401) -- the 400 is from the MCP transport layer, not auth.
        const resB = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          undefined,
          { Authorization: "Bearer token-b" },
        );
        expect(resB.statusCode).not.toBe(401);
      });

      /**
       * @case Lowercase "bearer" scheme is accepted (RFC 9110 case-insensitive)
       * @preconditions McpServer with auth; POST /mcp with "bearer" (lowercase) scheme
       * @expectedResult 200 status code (auth passes)
       */
      test("accepts lowercase bearer scheme per RFC 9110", async () => {
        const { post } = await startHttpServer([], {
          auth: { tokens: "valid-token" },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, {
          Authorization: "bearer valid-token",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Requests pass through unchanged when no auth option is configured
       * @preconditions McpServer without auth option; POST /mcp without Authorization header
       * @expectedResult 200 status code (backward compatible)
       */
      test("passes requests through when auth is not configured", async () => {
        const { post } = await startHttpServer([]);

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(200);
      });
    });
  });

  describe("buildAuthHeaders", () => {
    /**
     * @case Returns undefined when auth is undefined
     * @preconditions No auth options provided
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth is undefined", () => {
      expect(buildAuthHeaders(undefined)).toBeUndefined();
    });

    /**
     * @case Returns undefined when auth has no token or headers
     * @preconditions Empty auth options object
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth has no token or headers", () => {
      expect(buildAuthHeaders({})).toBeUndefined();
    });

    /**
     * @case Builds Authorization header from token
     * @preconditions auth.token is "my-token"
     * @expectedResult Headers with Authorization: Bearer my-token
     */
    test("builds Authorization header from token", () => {
      const result = buildAuthHeaders({ token: "my-token" });
      expect(result).toEqual({ Authorization: "Bearer my-token" });
    });

    /**
     * @case Passes through custom headers
     * @preconditions auth.headers has X-Custom: "value"
     * @expectedResult Headers with X-Custom: "value"
     */
    test("passes through custom headers", () => {
      const result = buildAuthHeaders({
        headers: { "X-Custom": "value" },
      });
      expect(result).toEqual({ "X-Custom": "value" });
    });

    /**
     * @case Custom headers override token when Authorization is set
     * @preconditions auth.token = "from-token" and auth.headers.Authorization = "Basic abc"
     * @expectedResult Authorization is "Basic abc" (headers override token)
     */
    test("custom Authorization header overrides token", () => {
      const result = buildAuthHeaders({
        token: "from-token",
        headers: { Authorization: "Basic abc" },
      });
      expect(result).toEqual({ Authorization: "Basic abc" });
    });

    /**
     * @case Lowercase authorization header overrides token case-insensitively
     * @preconditions auth.token = "from-token" and auth.headers.authorization = "Basic abc"
     * @expectedResult Single canonical Authorization header with "Basic abc"
     */
    test("lowercase authorization header overrides token case-insensitively", () => {
      const result = buildAuthHeaders({
        token: "from-token",
        headers: { authorization: "Basic abc" },
      });
      expect(result).toEqual({ Authorization: "Basic abc" });
    });

    /**
     * @case Throws on empty token string
     * @preconditions auth.token = ""
     * @expectedResult Error thrown about non-empty string
     */
    test("throws when token is an empty string", () => {
      expect(() => buildAuthHeaders({ token: "" })).toThrow(/non-empty string/);
    });
  });
});
