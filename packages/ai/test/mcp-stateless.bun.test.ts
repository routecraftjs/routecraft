/**
 * End-to-end coverage for MCP protocol revision 2026-07-28 (the stateless
 * revision) against a real Routecraft MCP server.
 *
 * These tests drive the server the way a deployed client does -- over a real
 * socket, with the official SDK v2 `Client` where possible and hand-built
 * JSON-RPC where a specific wire claim needs asserting. The contract under
 * test is the one the revision introduced: there is no `initialize` handshake
 * and no `Mcp-Session-Id`, so every request stands alone and any request may
 * land on any process.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { McpServer } from "../src/mcp/server.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  jwt,
  noop,
  type AnyRouteBuilder,
  type Principal,
} from "@routecraft/routecraft";
import { mcp } from "../src/index.ts";
import { MCP_PLUGIN_REGISTERED, McpHeadersKeys } from "../src/mcp/types.ts";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { rpcBody } from "./fixtures/rpc-body.ts";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

const ISSUER = "https://idp.test.example";
const AUDIENCE = "https://mcp.test.example";
const SECRET = "stateless-spec-test-secret";

/** Mint an HMAC JWT the `jwt()` validator accepts. */
function mintToken(
  claims: Record<string, unknown> = {},
  secret = SECRET,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: "user-42",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
    scope: "mcp:read",
    ...claims,
  };
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * The per-request `_meta` envelope that marks a request as revision
 * 2026-07-28. Under the stateless revision this replaces the handshake:
 * protocol version, client identity and client capabilities travel on every
 * request rather than being negotiated once per connection.
 */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "spec-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

describe("MCP 2026-07-28 stateless revision", () => {
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
    if (t) await t.stop();
  });

  /** Boot an HTTP MCP server on an ephemeral port with the given routes. */
  async function start(
    routes: AnyRouteBuilder[],
    options: Partial<ConstructorParameters<typeof McpServer>[1]> = {},
  ): Promise<{ port: number; url: string }> {
    t = await testContext().routes(routes).store(MCP_STORE_KEY, true).build();
    server = new McpServer(t.ctx, {
      transport: "http",
      port: 0,
      host: "127.0.0.1",
      ...options,
    });

    await t.startAndWaitReady();
    await server.start();
    const port = server.getHttpPort()!;
    return { port, url: `http://127.0.0.1:${port}/mcp` };
  }

  /** POST a JSON-RPC body straight at /mcp, returning status and payload. */
  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{
    status: number;
    headers: Headers;
    json: Record<string, unknown>;
  }> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: raw ? (JSON.parse(rpcBody(raw)) as Record<string, unknown>) : {},
    };
  }

  const echoRoute = (): AnyRouteBuilder =>
    craft()
      .id("echo")
      .title("Echo")
      .description("Echo the payload back")
      .input({ body: z.object({ value: z.string() }) })
      .from(mcp())
      .transform((p: { value: string }) => ({ echoed: p.value }))
      .to(noop()) as AnyRouteBuilder;

  describe("statelessness", () => {
    /**
     * @case A tools/call succeeds as the very first request on a fresh connection
     * @preconditions HTTP MCP server with one route; a single modern-envelope tools/call is posted with no initialize, no server/discover and no session header before it
     * @expectedResult 200 with the tool result, proving a request is self-describing and needs no prior handshake state
     */
    test("serves a tools/call with no handshake and no session", async () => {
      const { url } = await start([echoRoute()]);

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { value: "hi" },
            _meta: MODERN_META,
          },
        },
        { "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const result = res.json["result"] as {
        content: Array<{ text: string }>;
        resultType: string;
      };
      expect(result.resultType).toBe("complete");
      expect(JSON.parse(result.content[0]!.text)).toEqual({ echoed: "hi" });
    });

    /**
     * @case Independent requests never share state and never mint a session
     * @preconditions Three separate modern-envelope requests posted on fresh connections
     * @expectedResult All succeed and none carries Mcp-Session-Id, which is what allows any replica behind a load balancer to answer any request
     */
    test("mints no session id on any request", async () => {
      const { url } = await start([echoRoute()]);

      for (const method of ["server/discover", "tools/list", "tools/list"]) {
        const res = await post(
          url,
          { jsonrpc: "2.0", id: 1, method, params: { _meta: MODERN_META } },
          { "Mcp-Method": method },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("mcp-session-id")).toBeNull();
      }
    });

    /**
     * @case server/discover advertises the revision in place of the removed handshake
     * @preconditions HTTP MCP server; a server/discover request carrying the modern envelope
     * @expectedResult supportedVersions contains 2026-07-28, capabilities advertise tools, and identity arrives in result _meta under io.modelcontextprotocol/serverInfo
     */
    test("answers server/discover with its revision and identity", async () => {
      const { url } = await start([echoRoute()], {
        name: "sample-server",
        version: "3.1.4",
      });

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "server/discover" },
      );

      expect(res.status).toBe(200);
      const result = res.json["result"] as {
        supportedVersions: string[];
        capabilities: Record<string, unknown>;
        _meta: Record<string, { name: string; version: string }>;
      };
      expect(result.supportedVersions).toContain("2026-07-28");
      expect(result.capabilities["tools"]).toBeDefined();
      expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
        name: "sample-server",
        version: "3.1.4",
      });
    });

    /**
     * @case tools/list carries the cache hints the revision requires
     * @preconditions HTTP MCP server with one route; modern-envelope tools/list
     * @expectedResult The result carries ttlMs and cacheScope, the CacheableResult fields clients use to cache a list instead of re-polling it
     */
    test("returns cache hints on tools/list", async () => {
      const { url } = await start([echoRoute()]);

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "tools/list" },
      );

      const result = res.json["result"] as {
        tools: Array<{ name: string }>;
        ttlMs: number;
        cacheScope: string;
      };
      expect(result.tools.map((x) => x.name)).toContain("echo");
      expect(typeof result.ttlMs).toBe("number");
      expect(["public", "private"]).toContain(result.cacheScope);
    });
  });

  describe("SDK v2 client interop", () => {
    /**
     * @case A negotiating SDK client selects the modern era and calls a tool
     * @preconditions Real @modelcontextprotocol/client with versionNegotiation mode auto against the Routecraft server
     * @expectedResult getProtocolEra() is "modern" and both listTools and callTool return the route's tool and result
     */
    test("negotiates the modern era and calls tools", async () => {
      const { url } = await start([echoRoute()]);

      const client = new Client(
        { name: "interop-test", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(url));
      await client.connect(transport);

      try {
        expect(client.getProtocolEra()).toBe("modern");

        const listed = await client.listTools();
        expect(listed.tools.map((x) => x.name)).toContain("echo");

        const called = await client.callTool({
          name: "echo",
          arguments: { value: "through-the-sdk" },
        });
        const content = called.content as Array<{ text: string }>;
        expect(JSON.parse(content[0]!.text)).toEqual({
          echoed: "through-the-sdk",
        });
      } finally {
        await client.close();
        await transport.close();
      }
    });

    /**
     * @case A 2025-era client keeps working through the stateless legacy fallback
     * @preconditions Default SDK client (no versionNegotiation), which performs the 2025 initialize handshake
     * @expectedResult The era is "legacy" and tools still list and call, so upgrading the server does not break existing clients
     */
    test("still serves a 2025-era client", async () => {
      const { url } = await start([echoRoute()]);

      const client = new Client(
        { name: "legacy-test", version: "1.0.0" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(url));
      await client.connect(transport);

      try {
        expect(client.getProtocolEra()).toBe("legacy");

        const listed = await client.listTools();
        expect(listed.tools.map((x) => x.name)).toContain("echo");

        const called = await client.callTool({
          name: "echo",
          arguments: { value: "legacy" },
        });
        const content = called.content as Array<{ text: string }>;
        expect(JSON.parse(content[0]!.text)).toEqual({ echoed: "legacy" });
      } finally {
        await client.close();
        await transport.close();
      }
    });
  });

  describe("authentication", () => {
    const authOptions = () => ({
      auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
      resource: { url: "https://mcp.test.example/mcp" },
    });

    /** Route that captures the principal the exchange was branded with. */
    function capturingRoute(sink: {
      principal?: Principal | undefined;
    }): AnyRouteBuilder {
      return craft()
        .id("whoami")
        .description("Report the caller")
        .from(mcp())
        .process((ex) => {
          sink.principal = ex.principal;
          return ex;
        })
        .to(noop()) as AnyRouteBuilder;
    }

    /**
     * @case A valid bearer token authenticates a stateless tools/call and reaches the route
     * @preconditions jwt() validator auth; a modern-envelope tools/call carrying a freshly minted HS256 token and no prior handshake
     * @expectedResult 200, and the route exchange carries the verified principal with the token's subject and scopes
     */
    test("authenticates a bearer token on a single self-contained request", async () => {
      const sink: { principal?: Principal | undefined } = {};
      const { url } = await start([capturingRoute(sink)], authOptions());

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {}, _meta: MODERN_META },
        },
        {
          Authorization: `Bearer ${mintToken()}`,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "whoami",
        },
      );

      expect(res.status).toBe(200);
      expect(sink.principal).toBeDefined();
      expect(sink.principal!.subject).toBe("user-42");
      expect(sink.principal!.scopes).toContain("mcp:read");
    });

    /**
     * @case Auth is enforced per request, not per session
     * @preconditions One authenticated request succeeds, then an identical request is sent with no Authorization header
     * @expectedResult The second request is refused with 401 -- there is no session for the first request's credentials to persist into
     */
    test("re-authenticates every request", async () => {
      const sink: { principal?: Principal | undefined } = {};
      const { url } = await start([capturingRoute(sink)], authOptions());

      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {}, _meta: MODERN_META },
      };
      const headers = { "Mcp-Method": "tools/call", "Mcp-Name": "whoami" };

      const authed = await post(url, body, {
        ...headers,
        Authorization: `Bearer ${mintToken()}`,
      });
      expect(authed.status).toBe(200);

      const anonymous = await post(url, body, headers);
      expect(anonymous.status).toBe(401);
    });

    /**
     * @case A rejected request advertises RFC 9728 discovery
     * @preconditions jwt() validator auth with an explicit resource.url; unauthenticated tools/list
     * @expectedResult 401 whose WWW-Authenticate carries an absolute resource_metadata URL pointing at the protected-resource document
     */
    test("advertises resource_metadata on a 401", async () => {
      const { url } = await start([echoRoute()], authOptions());

      const res = await post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: MODERN_META },
      });

      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate");
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(
        'resource_metadata="https://mcp.test.example/.well-known/oauth-protected-resource',
      );
    });

    /**
     * @case A token signed with the wrong key is refused
     * @preconditions jwt() validator auth; tools/call carrying a token minted with a different secret
     * @expectedResult 401, and the route never runs
     */
    test("rejects a token with an invalid signature", async () => {
      const sink: { principal?: Principal | undefined } = {};
      const { url } = await start([capturingRoute(sink)], authOptions());

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {}, _meta: MODERN_META },
        },
        {
          Authorization: `Bearer ${mintToken({}, "the-wrong-secret")}`,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "whoami",
        },
      );

      expect(res.status).toBe(401);
      expect(sink.principal).toBeUndefined();
    });

    /**
     * @case An expired token is refused
     * @preconditions jwt() validator auth; tools/call carrying a correctly signed token whose exp is in the past
     * @expectedResult 401
     */
    test("rejects an expired token", async () => {
      const { url } = await start([echoRoute()], authOptions());

      const res = await post(
        url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        {
          Authorization: `Bearer ${mintToken({
            exp: Math.floor(Date.now() / 1000) - 60,
          })}`,
          "Mcp-Method": "tools/list",
        },
      );

      expect(res.status).toBe(401);
    });

    /**
     * @case An authenticated SDK client drives the whole flow end to end
     * @preconditions Real SDK v2 client negotiating auto, sending a bearer token via requestInit headers
     * @expectedResult The modern era is negotiated, the tool call succeeds, and the route sees the authenticated principal
     */
    test("authenticates a negotiating SDK client", async () => {
      const sink: { principal?: Principal | undefined } = {};
      const { url } = await start([capturingRoute(sink)], authOptions());

      const client = new Client(
        { name: "auth-interop", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${mintToken()}` } },
      });
      await client.connect(transport);

      try {
        expect(client.getProtocolEra()).toBe("modern");
        await client.callTool({ name: "whoami", arguments: {} });
        expect(sink.principal?.subject).toBe("user-42");
      } finally {
        await client.close();
        await transport.close();
      }
    });
  });

  describe("exchange headers", () => {
    /**
     * @case Each call carries a fresh per-request correlation id
     * @preconditions Two tools/call requests against a route that captures McpHeadersKeys.REQUEST
     * @expectedResult Both ids are non-empty and differ, replacing the session identifier the revision removed
     */
    test("stamps a distinct request id per call", async () => {
      const seen: string[] = [];
      const route = craft()
        .id("mark")
        .description("Capture the request id")
        .from(mcp())
        .process((ex) => {
          seen.push(ex.headers[McpHeadersKeys.REQUEST] as string);
          return ex;
        })
        .to(noop()) as AnyRouteBuilder;

      const { url } = await start([route]);

      for (const id of [1, 2]) {
        const res = await post(
          url,
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "mark", arguments: {}, _meta: MODERN_META },
          },
          { "Mcp-Method": "tools/call", "Mcp-Name": "mark" },
        );
        expect(res.status).toBe(200);
      }

      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeTruthy();
      expect(seen[0]).not.toBe(seen[1]);
    });
  });
});
