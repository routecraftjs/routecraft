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

  /**
   * @case Annotations from mcp() options are included in getAvailableTools() output
   * @preconditions Route uses mcp() with annotations
   * @expectedResult Tool listing includes the annotations object
   */
  test("includes annotations in tool listing", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("annotated")
          .from(
            mcp("annotated-tool", {
              description: "An annotated tool",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
              },
            }),
          )
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.test();
    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  /**
   * @case Tools without annotations omit the field from getAvailableTools()
   * @preconditions Route uses mcp() without annotations
   * @expectedResult Tool listing has no annotations key
   */
  test("omits annotations when not provided", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("plain")
          .from(mcp("plain-tool", { description: "No annotations" }))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.test();
    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).not.toHaveProperty("annotations");
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
              t.ctx.on("route:*:started" as const, () => {
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
     * @case tools/list JSON-RPC response includes annotations forwarded on the wire
     * @preconditions HTTP server with a route declaring annotations; initialize then tools/list
     * @expectedResult The parsed response body contains the annotations object on the matching tool
     */
    test("tools/list forwards annotations on the wire", async () => {
      const { post, initSession } = await startHttpServer([
        craft()
          .id("annotated-http")
          .from(
            mcp("annotated-http-tool", {
              description: "Tool with annotations over HTTP",
              annotations: {
                title: "Annotated Tool",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
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
      const tools = parsed.result.tools as Array<{
        name: string;
        annotations?: Record<string, unknown>;
      }>;
      const annotated = tools.find((t) => t.name === "annotated-http-tool");
      expect(annotated).toBeDefined();
      expect(annotated?.annotations).toEqual({
        title: "Annotated Tool",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
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
      const validPrincipal = {
        kind: "custom" as const,
        subject: "user-1",
        scheme: "bearer" as const,
      };

      /**
       * @case Request without Authorization header returns 401 when auth is configured
       * @preconditions McpServer with auth.validator set; POST /mcp without Authorization header
       * @expectedResult 401 status code with WWW-Authenticate header
       */
      test("returns 401 when no Authorization header and auth is configured", async () => {
        const { post } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
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
       * @case Request with rejected token returns 401
       * @preconditions McpServer with auth.validator that throws; POST /mcp with token
       * @expectedResult 401 status code
       */
      test("returns 401 when validator throws", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: () => {
              throw new Error("invalid token");
            },
          },
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
       * @case Request with valid token returns 200
       * @preconditions McpServer with auth.validator returning principal; POST /mcp with bearer token
       * @expectedResult 200 status code and MCP session established
       */
      test("accepts request when validator returns principal", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: (token) => {
              if (token !== "valid-token") throw new Error("invalid token");
              return validPrincipal;
            },
          },
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
       * @case Lowercase "bearer" scheme is accepted (RFC 9110 case-insensitive)
       * @preconditions McpServer with auth; POST /mcp with "bearer" (lowercase) scheme
       * @expectedResult 200 status code (auth passes)
       */
      test("accepts lowercase bearer scheme per RFC 9110", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: (token) => {
              if (token !== "valid-token") throw new Error("invalid token");
              return validPrincipal;
            },
          },
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

      /**
       * @case Async validator that resolves to principal allows access
       * @preconditions McpServer with async auth.validator resolving to AuthPrincipal
       * @expectedResult 200 status code
       */
      test("accepts request when async validator resolves principal", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: async (token) => {
              if (token !== "async-valid") throw new Error("invalid token");
              return validPrincipal;
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, {
          Authorization: "Bearer async-valid",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Async validator that rejects access by throwing
       * @preconditions McpServer with async auth.validator that always throws
       * @expectedResult 401 status code
       */
      test("returns 401 when async validator throws", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: async () => {
              throw new Error("invalid token");
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, undefined, {
          Authorization: "Bearer any-token",
        });
        expect(res.statusCode).toBe(401);
      });
    });

    describe("oauth auth", () => {
      /**
       * @case oauth() verify returning a fully populated Principal surfaces every identity field as a routecraft.auth.* header
       * @preconditions McpServer with oauth() auth; verify returns subject, clientId, email, name, issuer, audience, roles, scopes, expiresAt, claims
       * @expectedResult Route's tap receives exchange headers with auth.subject = JWT sub (not clientId), auth.client_id, auth.email, auth.name, auth.issuer, auth.audience, auth.roles, auth.scopes, auth.scheme
       */
      test("surfaces full principal claims as exchange headers", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        let captured: Record<string, string | string[] | undefined> | undefined;

        const authConfig = oauth({
          resourceIssuerUrl: "http://localhost:9999",
          endpoints: {
            authorizationUrl: "http://localhost:9999/authorize",
            tokenUrl: "http://localhost:9999/token",
          },
          verify: async (token) => {
            expect(token).toBe("rich-token");
            return {
              kind: "oauth" as const,
              scheme: "bearer" as const,
              subject: "user-42",
              clientId: "client-abc",
              name: "Ada Lovelace",
              email: "ada@example.com",
              issuer: "https://idp.example.com",
              audience: ["mcp.example.com"],
              scopes: ["email", "profile"],
              roles: ["admin"],
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
              claims: { sub: "user-42", custom: "value" },
            };
          },
          client: async (clientId) => ({
            client_id: clientId,
            redirect_uris: ["http://localhost:3000/callback"],
          }),
        });

        const { post, initSession } = await startHttpServer(
          [
            craft()
              .id("oauth-capture")
              .from(
                mcp("oauth-capture", {
                  description: "Capture exchange headers for OAuth test",
                  schema: z.object({}),
                }),
              )
              .tap((ex) => {
                captured = ex.headers as Record<
                  string,
                  string | string[] | undefined
                >;
              })
              .to(noop()),
          ],
          { auth: authConfig },
        );

        const sessionId = await initSession({
          Authorization: "Bearer rich-token",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "oauth-capture", arguments: {} },
          }),
          sessionId,
          { Authorization: "Bearer rich-token" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(captured).toBeDefined();
        const h = captured as Record<string, string | string[] | undefined>;
        expect(h["routecraft.auth.subject"]).toBe("user-42");
        expect(h["routecraft.auth.client_id"]).toBe("client-abc");
        expect(h["routecraft.auth.scheme"]).toBe("bearer");
        expect(h["routecraft.auth.name"]).toBe("Ada Lovelace");
        expect(h["routecraft.auth.email"]).toBe("ada@example.com");
        expect(h["routecraft.auth.issuer"]).toBe("https://idp.example.com");
        expect(h["routecraft.auth.audience"]).toEqual(["mcp.example.com"]);
        expect(h["routecraft.auth.roles"]).toEqual(["admin"]);
        expect(h["routecraft.auth.scopes"]).toEqual(["email", "profile"]);
      });

      /**
       * @case Minimal Principal (no identity enrichment) populates only subject, client_id, scheme, scopes
       * @preconditions McpServer with oauth(); verify returns only required fields (kind, scheme, subject, clientId, scopes)
       * @expectedResult Exchange headers include subject, client_id, scheme, scopes; optional identity headers are absent
       */
      test("minimal principal omits optional identity headers", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        let captured: Record<string, string | string[] | undefined> | undefined;

        const authConfig = oauth({
          resourceIssuerUrl: "http://localhost:9999",
          endpoints: {
            authorizationUrl: "http://localhost:9999/authorize",
            tokenUrl: "http://localhost:9999/token",
          },
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "client-only",
            clientId: "client-only",
            scopes: ["read"],
            // expiresAt is required by the MCP SDK's requireBearerAuth middleware.
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          }),
          client: async (clientId) => ({
            client_id: clientId,
            redirect_uris: ["http://localhost:3000/callback"],
          }),
        });

        const { post, initSession } = await startHttpServer(
          [
            craft()
              .id("oauth-minimal")
              .from(
                mcp("oauth-minimal", {
                  description: "Minimal OAuth capture",
                  schema: z.object({}),
                }),
              )
              .tap((ex) => {
                captured = ex.headers as Record<
                  string,
                  string | string[] | undefined
                >;
              })
              .to(noop()),
          ],
          { auth: authConfig },
        );

        const sessionId = await initSession({
          Authorization: "Bearer any",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "oauth-minimal", arguments: {} },
          }),
          sessionId,
          { Authorization: "Bearer any" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(captured).toBeDefined();
        const h = captured as Record<string, string | string[] | undefined>;
        expect(h["routecraft.auth.subject"]).toBe("client-only");
        expect(h["routecraft.auth.client_id"]).toBe("client-only");
        expect(h["routecraft.auth.scheme"]).toBe("bearer");
        expect(h["routecraft.auth.scopes"]).toEqual(["read"]);
        expect(h["routecraft.auth.email"]).toBeUndefined();
        expect(h["routecraft.auth.name"]).toBeUndefined();
        expect(h["routecraft.auth.issuer"]).toBeUndefined();
        expect(h["routecraft.auth.audience"]).toBeUndefined();
      });

      /**
       * @case Runtime guard rejects a principal without expiresAt smuggled past the type system
       * @preconditions McpServer with oauth() auth; verify is cast to bypass the OAuthPrincipal
       *                type contract and return a principal without expiresAt (simulating a
       *                dynamically wired plugin or `as any` escape hatch in user code)
       * @expectedResult HTTP 401 response; auth:rejected event emitted with reason "missing_expires_at"
       */
      test("rejects principal without expiresAt and emits auth:rejected", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");

        const rejections: Array<Record<string, unknown>> = [];

        // Deliberately bypass the OAuthPrincipal type constraint to exercise
        // the runtime defense-in-depth guard.
        const unsafeVerify = async () => ({
          kind: "oauth" as const,
          scheme: "bearer" as const,
          subject: "user-no-exp",
          clientId: "client-abc",
          // expiresAt intentionally omitted
        });

        const authConfig = oauth({
          resourceIssuerUrl: "http://localhost:9999",
          endpoints: {
            authorizationUrl: "http://localhost:9999/authorize",
            tokenUrl: "http://localhost:9999/token",
          },
          verify: unsafeVerify as unknown as Parameters<
            typeof oauth
          >[0]["verify"],
          client: async (clientId) => ({
            client_id: clientId,
            redirect_uris: ["http://localhost:3000/callback"],
          }),
        });

        t = await testContext().store(MCP_STORE_KEY, true).build();
        server = new McpServer(t.ctx, {
          transport: "http",
          port: 0,
          host: "127.0.0.1",
          auth: authConfig,
        });

        t.ctx.on("auth:rejected", (payload) => {
          rejections.push(payload.details as Record<string, unknown>);
        });

        void t.ctx.start();
        await server.start();
        const port = server.getHttpPort()!;

        const res = await new Promise<{ statusCode: number }>(
          (resolve, reject) => {
            const req = http.request(
              {
                host: "127.0.0.1",
                port,
                path: "/mcp",
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  Authorization: "Bearer some-token",
                },
              },
              (r) => {
                r.resume();
                r.on("end", () => resolve({ statusCode: r.statusCode ?? 0 }));
              },
            );
            req.on("error", reject);
            req.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: INIT_PARAMS,
              }),
            );
            req.end();
          },
        );

        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(rejections).toHaveLength(1);
        expect(rejections[0]).toMatchObject({
          reason: "missing_expires_at",
          scheme: "bearer",
          source: "mcp",
          path: "oauth",
        });
      });
    });

    describe("principal kinds via validator", () => {
      /**
       * @case Validator returning a JwtPrincipal surfaces JWT-specific claims as headers
       * @preconditions McpServer with validator returning kind: "jwt" with claims, issuer, audience, roles
       * @expectedResult Exchange headers include auth.issuer, auth.audience, auth.roles, auth.email, auth.name
       */
      test("jwt principal populates jwt-specific headers", async () => {
        let captured: Record<string, string | string[] | undefined> | undefined;

        const { post, initSession } = await startHttpServer(
          [
            craft()
              .id("jwt-capture")
              .from(
                mcp("jwt-capture", {
                  description: "Capture JWT principal headers",
                  schema: z.object({}),
                }),
              )
              .tap((ex) => {
                captured = ex.headers as Record<
                  string,
                  string | string[] | undefined
                >;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "jwt" as const,
                scheme: "bearer" as const,
                subject: "jwt-user",
                name: "JWT User",
                email: "jwt@example.com",
                issuer: "https://idp.example.com",
                audience: ["aud-a", "aud-b"],
                scopes: ["read", "write"],
                roles: ["member"],
                expiresAt: Math.floor(Date.now() / 1000) + 600,
                claims: { sub: "jwt-user" },
              }),
            },
          },
        );

        const sessionId = await initSession({
          Authorization: "Bearer jwt",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "jwt-capture", arguments: {} },
          }),
          sessionId,
          { Authorization: "Bearer jwt" },
        );
        expect(callRes.statusCode).toBe(200);

        const h = captured as Record<string, string | string[] | undefined>;
        expect(h["routecraft.auth.subject"]).toBe("jwt-user");
        expect(h["routecraft.auth.name"]).toBe("JWT User");
        expect(h["routecraft.auth.email"]).toBe("jwt@example.com");
        expect(h["routecraft.auth.issuer"]).toBe("https://idp.example.com");
        expect(h["routecraft.auth.audience"]).toEqual(["aud-a", "aud-b"]);
        expect(h["routecraft.auth.roles"]).toEqual(["member"]);
        expect(h["routecraft.auth.scopes"]).toEqual(["read", "write"]);
        // JWT principals have no clientId — header must be absent.
        expect(h["routecraft.auth.client_id"]).toBeUndefined();
      });

      /**
       * @case Validator returning a custom Principal surfaces subject and name but no JWT-specific headers
       * @preconditions McpServer with validator returning kind: "custom" with a name
       * @expectedResult Exchange headers include auth.subject, auth.scheme, auth.name; JWT-only headers are absent
       */
      test("custom principal omits jwt-only headers", async () => {
        let captured: Record<string, string | string[] | undefined> | undefined;

        const { post, initSession } = await startHttpServer(
          [
            craft()
              .id("apikey-capture")
              .from(
                mcp("apikey-capture", {
                  description: "Capture API key principal headers",
                  schema: z.object({}),
                }),
              )
              .tap((ex) => {
                captured = ex.headers as Record<
                  string,
                  string | string[] | undefined
                >;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "key-123",
                name: "Deploy key",
              }),
            },
          },
        );

        const sessionId = await initSession({
          Authorization: "Bearer key",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "apikey-capture", arguments: {} },
          }),
          sessionId,
          { Authorization: "Bearer key" },
        );
        expect(callRes.statusCode).toBe(200);

        const h = captured as Record<string, string | string[] | undefined>;
        expect(h["routecraft.auth.subject"]).toBe("key-123");
        expect(h["routecraft.auth.scheme"]).toBe("bearer");
        expect(h["routecraft.auth.name"]).toBe("Deploy key");
        expect(h["routecraft.auth.email"]).toBeUndefined();
        expect(h["routecraft.auth.issuer"]).toBeUndefined();
        expect(h["routecraft.auth.audience"]).toBeUndefined();
        expect(h["routecraft.auth.scopes"]).toBeUndefined();
        expect(h["routecraft.auth.client_id"]).toBeUndefined();
      });
    });
  });

  describe("plugin events", () => {
    /**
     * @case server:listening event is emitted with host, port, and path
     * @preconditions McpServer with HTTP transport started on port 0
     * @expectedResult Event emitted once with correct payload
     */
    test("emits plugin:mcp:server:listening on HTTP start", async () => {
      t = await testContext().store(MCP_STORE_KEY, true).build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const events: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:server:listening", (payload) => {
        events.push(payload.details as Record<string, unknown>);
      });

      void t.ctx.start();
      await server.start();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        host: "127.0.0.1",
        path: "/mcp",
      });
      expect(events[0]!.port).toBeTypeOf("number");
      expect((events[0]!.port as number) > 0).toBe(true);
    });

    /**
     * @case session:created event is emitted when HTTP session initializes
     * @preconditions McpServer with HTTP transport; send initialize request
     * @expectedResult Event emitted with sessionId string
     */
    test("emits plugin:mcp:session:created on initialize", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("evt-tool")
            .from(mcp("evt-tool", { description: "test" }))
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const sessions: string[] = [];
      t.ctx.on("plugin:mcp:session:created", (payload) => {
        const d = payload.details as { sessionId: string };
        sessions.push(d.sessionId);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:*:started" as const, () => {
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

      // Send initialize to trigger session creation
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toBeTypeOf("string");
      expect(sessions[0]!.length).toBeGreaterThan(0);
    });

    /**
     * @case tools:exposed event is emitted with tool names and count
     * @preconditions McpServer with one mcp() route; request tools/list
     * @expectedResult Event emitted with tools array and count
     */
    test("emits plugin:mcp:server:tools:exposed on first tools list", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("exposed-evt")
            .from(mcp("exposed-evt", { description: "test" }))
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const exposed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:server:tools:exposed", (payload) => {
        exposed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:*:started" as const, () => {
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

      // tools:exposed fires on start or first tools/list
      expect(exposed).toHaveLength(1);
      expect(exposed[0]).toMatchObject({
        tools: ["exposed-evt"],
        count: 1,
      });
    });

    /**
     * @case tool:called, tool:completed events emitted on successful tool call
     * @preconditions McpServer with HTTP transport; call a tool via JSON-RPC
     * @expectedResult called event with tool name and args, completed event with tool name
     */
    test("emits tool:called and tool:completed on success", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("call-evt")
            .from(
              mcp("call-evt", {
                description: "test",
                inputSchema: {
                  type: "object",
                  properties: { x: { type: "number" } },
                },
              }),
            )
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const called: Array<Record<string, unknown>> = [];
      const completed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:called", (payload) => {
        called.push(payload.details as Record<string, unknown>);
      });
      t.ctx.on("plugin:mcp:tool:completed", (payload) => {
        completed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:*:started" as const, () => {
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

      // Initialize session
      const initRes = await new Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
              }),
            );
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      const sessionId = initRes.headers["mcp-session-id"] as string;

      // Call the tool
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": sessionId,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "call-evt", arguments: { x: 42 } },
          }),
        );
        req.end();
      });

      expect(called).toHaveLength(1);
      expect(called[0]).toMatchObject({ tool: "call-evt", args: { x: 42 } });

      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ tool: "call-evt" });
    });

    /**
     * @case tool:failed event emitted when tool call errors
     * @preconditions McpServer with HTTP transport; call a non-existent tool
     * @expectedResult failed event with tool name and error message
     */
    test("emits tool:failed when tool not found", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("exists-evt")
            .from(mcp("exists-evt", { description: "test" }))
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const failed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:failed", (payload) => {
        failed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:*:started" as const, () => {
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

      // Initialize session
      const initRes = await new Promise<{
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      const sessionId = initRes.headers["mcp-session-id"] as string;

      // Call a tool that does not exist
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": sessionId,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "no-such-tool", arguments: {} },
          }),
        );
        req.end();
      });

      expect(failed).toHaveLength(1);
      expect(failed[0]!.tool).toBe("no-such-tool");
      expect(failed[0]!.error).toBeTypeOf("string");
    });

    /**
     * @case Wildcard plugin:mcp:tool:** catches all tool events
     * @preconditions McpServer with HTTP transport; subscribe with globstar pattern
     * @expectedResult Both called and completed events captured by single wildcard handler
     */
    test("wildcard plugin:mcp:tool:** captures all tool events", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("wc-tool")
            .from(
              mcp("wc-tool", {
                description: "test",
                inputSchema: { type: "object", properties: {} },
              }),
            )
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
      });

      const allToolEvents: string[] = [];
      t.ctx.on("plugin:mcp:tool:**", (payload) => {
        const d = payload.details as { tool?: string };
        allToolEvents.push(d.tool ?? "unknown");
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:*:started" as const, () => {
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

      // Initialize session
      const initRes = await new Promise<{
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      const sessionId = initRes.headers["mcp-session-id"] as string;

      // Call the tool
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": sessionId,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "wc-tool", arguments: {} },
          }),
        );
        req.end();
      });

      // Should capture both called and completed
      expect(allToolEvents.length).toBeGreaterThanOrEqual(2);
      expect(allToolEvents.filter((t) => t === "wc-tool")).toHaveLength(2);
    });

    /**
     * @case auth:success event emitted with principal details on valid auth
     * @preconditions McpServer with auth validator; send request with valid token
     * @expectedResult Event emitted with subject, scheme, and source
     */
    test("emits auth:success on valid token", async () => {
      t = await testContext().store(MCP_STORE_KEY, true).build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
        auth: {
          validator: (token) => {
            if (token !== "good") throw new Error("invalid token");
            return {
              kind: "custom" as const,
              subject: "user-1",
              scheme: "bearer" as const,
            };
          },
        },
      });

      const successes: Array<Record<string, unknown>> = [];
      t.ctx.on("auth:success", (payload) => {
        successes.push(payload.details as Record<string, unknown>);
      });

      void t.ctx.start();
      await server.start();
      const port = server.getHttpPort()!;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: "Bearer good",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        subject: "user-1",
        scheme: "bearer",
        source: "mcp",
      });
    });

    /**
     * @case auth:rejected event emitted with reason on invalid token
     * @preconditions McpServer with auth validator; send request with bad token
     * @expectedResult Event emitted with reason and source
     */
    test("emits auth:rejected on invalid token", async () => {
      t = await testContext().store(MCP_STORE_KEY, true).build();
      server = new McpServer(t.ctx, {
        transport: "http",
        port: 0,
        host: "127.0.0.1",
        auth: {
          validator: () => {
            throw new Error("invalid token");
          },
        },
      });

      const rejections: Array<Record<string, unknown>> = [];
      t.ctx.on("auth:rejected", (payload) => {
        rejections.push(payload.details as Record<string, unknown>);
      });

      void t.ctx.start();
      await server.start();
      const port = server.getHttpPort()!;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: "Bearer bad",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        reason: "invalid token",
        scheme: "bearer",
        source: "mcp",
      });
    });
  });

  describe("buildAuthHeaders", () => {
    /**
     * @case Returns undefined when auth is undefined
     * @preconditions No auth options provided
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth is undefined", async () => {
      expect(await buildAuthHeaders(undefined)).toBeUndefined();
    });

    /**
     * @case Returns undefined when auth has no token or headers
     * @preconditions Empty auth options object
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth has no token or headers", async () => {
      expect(await buildAuthHeaders({})).toBeUndefined();
    });

    /**
     * @case Builds Authorization header from token
     * @preconditions auth.token is "my-token"
     * @expectedResult Headers with Authorization: Bearer my-token
     */
    test("builds Authorization header from token", async () => {
      const result = await buildAuthHeaders({ token: "my-token" });
      expect(result).toEqual({ Authorization: "Bearer my-token" });
    });

    /**
     * @case Passes through custom headers
     * @preconditions auth.headers has X-Custom: "value"
     * @expectedResult Headers with X-Custom: "value"
     */
    test("passes through custom headers", async () => {
      const result = await buildAuthHeaders({
        headers: { "X-Custom": "value" },
      });
      expect(result).toEqual({ "X-Custom": "value" });
    });

    /**
     * @case Custom headers override token when Authorization is set
     * @preconditions auth.token = "from-token" and auth.headers.Authorization = "Basic abc"
     * @expectedResult Authorization is "Basic abc" (headers override token)
     */
    test("custom Authorization header overrides token", async () => {
      const result = await buildAuthHeaders({
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
    test("lowercase authorization header overrides token case-insensitively", async () => {
      const result = await buildAuthHeaders({
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
    test("throws when token is an empty string", async () => {
      await expect(buildAuthHeaders({ token: "" })).rejects.toThrow(
        /non-empty string/,
      );
    });

    /**
     * @case Resolves token from a string array using round-robin
     * @preconditions auth.token is ["token-a", "token-b"]
     * @expectedResult First call uses token-a, second uses token-b, third wraps to token-a
     */
    test("resolves token from array with round-robin", async () => {
      const tokens = ["token-a", "token-b"];
      const r1 = await buildAuthHeaders({ token: tokens });
      expect(r1).toEqual({ Authorization: "Bearer token-a" });
      const r2 = await buildAuthHeaders({ token: tokens });
      expect(r2).toEqual({ Authorization: "Bearer token-b" });
      const r3 = await buildAuthHeaders({ token: tokens });
      expect(r3).toEqual({ Authorization: "Bearer token-a" });
    });

    /**
     * @case Throws on empty token array
     * @preconditions auth.token is []
     * @expectedResult Error thrown about empty array
     */
    test("throws when token is an empty array", async () => {
      await expect(buildAuthHeaders({ token: [] })).rejects.toThrow(
        /must not be empty/,
      );
    });

    /**
     * @case Resolves token from a synchronous provider function
     * @preconditions auth.token is () => "dynamic-token"
     * @expectedResult Headers with Authorization: Bearer dynamic-token
     */
    test("resolves token from sync provider function", async () => {
      const result = await buildAuthHeaders({ token: () => "dynamic-token" });
      expect(result).toEqual({ Authorization: "Bearer dynamic-token" });
    });

    /**
     * @case Resolves token from an async provider function
     * @preconditions auth.token is async () => "async-token"
     * @expectedResult Headers with Authorization: Bearer async-token
     */
    test("resolves token from async provider function", async () => {
      const result = await buildAuthHeaders({
        token: async () => "async-token",
      });
      expect(result).toEqual({ Authorization: "Bearer async-token" });
    });

    /**
     * @case Throws when provider function returns empty string
     * @preconditions auth.token is () => ""
     * @expectedResult Error thrown about non-empty string
     */
    test("throws when provider function returns empty string", async () => {
      await expect(buildAuthHeaders({ token: () => "" })).rejects.toThrow(
        /non-empty string/,
      );
    });
  });

  describe("authInfoToPrincipal fallback", () => {
    /**
     * @case Fallback derives a minimal OAuthPrincipal when extra.principal is absent
     * @preconditions Caller passes a raw SdkAuthInfo without a stashed principal in extra
     * @expectedResult Returns OAuthPrincipal with subject == clientId, scopes copied through, expiresAt preserved
     */
    test("fallback derives OAuthPrincipal from bare SdkAuthInfo", async () => {
      t = await testContext().build();
      server = new McpServer(t.ctx);
      const anyServer = server as unknown as {
        authInfoToPrincipal: (info: unknown) => unknown;
      };

      const principal = anyServer.authInfoToPrincipal({
        token: "t",
        clientId: "client-abc",
        scopes: ["read"],
        expiresAt: 1234,
      });

      expect(principal).toMatchObject({
        kind: "oauth",
        scheme: "bearer",
        subject: "client-abc",
        clientId: "client-abc",
        scopes: ["read"],
        expiresAt: 1234,
      });
    });

    /**
     * @case Fallback omits expiresAt when it is absent on the SdkAuthInfo
     * @preconditions SdkAuthInfo without expiresAt and without extra.principal
     * @expectedResult Returned principal has no expiresAt key
     */
    test("fallback omits expiresAt when absent", async () => {
      t = await testContext().build();
      server = new McpServer(t.ctx);
      const anyServer = server as unknown as {
        authInfoToPrincipal: (info: unknown) => Record<string, unknown>;
      };

      const principal = anyServer.authInfoToPrincipal({
        token: "t",
        clientId: "client-abc",
        scopes: [],
      });

      expect(principal).toMatchObject({
        kind: "oauth",
        subject: "client-abc",
        clientId: "client-abc",
      });
      expect(principal["expiresAt"]).toBeUndefined();
    });

    /**
     * @case Stashed principal in extra.principal is preferred over fallback
     * @preconditions SdkAuthInfo carries extra.principal with a full OAuthPrincipal whose subject differs from clientId
     * @expectedResult Returns the stashed principal verbatim (subject is not overwritten with clientId)
     */
    test("uses stashed principal when present, preserving subject != clientId", async () => {
      t = await testContext().build();
      server = new McpServer(t.ctx);
      const anyServer = server as unknown as {
        authInfoToPrincipal: (info: unknown) => Record<string, unknown>;
      };

      const stashed = {
        kind: "oauth" as const,
        scheme: "bearer" as const,
        subject: "real-user-42",
        clientId: "client-abc",
        scopes: ["read", "write"],
        email: "user@example.com",
      };

      const principal = anyServer.authInfoToPrincipal({
        token: "t",
        clientId: "client-abc",
        scopes: ["read", "write"],
        extra: { principal: stashed },
      });

      expect(principal).toEqual(stashed);
      expect(principal["subject"]).toBe("real-user-42");
    });

    /**
     * @case Returns undefined for undefined input
     * @preconditions Caller passes undefined (no auth on the request)
     * @expectedResult undefined (no principal to surface)
     */
    test("returns undefined when authInfo is undefined", async () => {
      t = await testContext().build();
      server = new McpServer(t.ctx);
      const anyServer = server as unknown as {
        authInfoToPrincipal: (info: unknown) => unknown;
      };

      expect(anyServer.authInfoToPrincipal(undefined)).toBeUndefined();
    });
  });
});
