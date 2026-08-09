/**
 * Capability-level coverage: several real Routecraft routes exposed as MCP
 * tools over the stateless 2026-07-28 wire, behind RS256 JWT authentication.
 *
 * The other MCP suites test the transport and the auth gate in isolation. This
 * one asks the question an operator actually cares about: with a handful of
 * differently-shaped capabilities published and a real asymmetric-key IdP in
 * front of them, does each one list, validate, authorise and execute correctly
 * when every request has to stand on its own?
 *
 * The signing key pair is generated in-process, so the suite exercises the
 * asymmetric path (`publicKey` verification, the shape a real IdP uses) without
 * a fixture key checked into the repo.
 */
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { McpServer } from "../src/mcp/server.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, jwt, noop, type AnyRouteBuilder } from "@routecraft/routecraft";
import { mcp } from "../src/index.ts";
import { MCP_PLUGIN_REGISTERED } from "../src/mcp/types.ts";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

const ISSUER = "https://idp.capabilities.example";
const AUDIENCE = "https://mcp.capabilities.example";

/** Self-generated RSA key pair standing in for an IdP's signing key. */
let publicKey: string;
let privateKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
});

/** Mint an RS256 JWT signed with the generated private key. */
function mintRs256(claims: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    sub: "analyst-7",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
    scope: "catalogue:read",
    roles: ["analyst"],
    ...claims,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

describe("capabilities exposed as MCP tools", () => {
  let t: TestContext;
  let server: McpServer;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    try {
      await transport?.close();
    } catch {
      // ignore
    }
    client = undefined;
    transport = undefined;
    try {
      await server?.stop();
    } catch {
      // ignore
    }
    if (t) await t.stop();
  });

  /** Products the catalogue capability searches over. */
  const CATALOGUE = [
    { sku: "RC-1", name: "Router", price: 120 },
    { sku: "RC-2", name: "Switch", price: 80 },
    { sku: "RC-3", name: "Firewall", price: 340 },
  ];

  /**
   * Four capabilities with deliberately different shapes: a validated
   * search returning structured output, a pure computation, a capability
   * gated by `authorize()` on a role claim, and one that fails on purpose.
   */
  function capabilities(): AnyRouteBuilder[] {
    return [
      craft()
        .id("search_catalogue")
        .title("Search catalogue")
        .description("Find products whose name matches a query")
        .input({ body: z.object({ query: z.string().min(1) }) })
        .output({
          body: z.object({
            matches: z.array(
              z.object({
                sku: z.string(),
                name: z.string(),
                price: z.number(),
              }),
            ),
          }),
        })
        .from(mcp())
        .transform((p: { query: string }) => ({
          matches: CATALOGUE.filter((item) => item.name
            .toLowerCase()
            .includes(p.query.toLowerCase())),
        }))
        .to(noop()) as AnyRouteBuilder,

      craft()
        .id("quote_total")
        .title("Quote total")
        .description("Total a basket of line items including VAT")
        .input({
          body: z.object({
            lines: z.array(z.object({ price: z.number(), qty: z.number() })),
            vatRate: z.number().default(0.21),
          }),
        })
        .from(mcp())
        .transform(
          (p: {
            lines: Array<{ price: number; qty: number }>;
            vatRate: number;
          }) => {
            const net = p.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
            return { net, vat: net * p.vatRate, gross: net * (1 + p.vatRate) };
          },
        )
        .to(noop()) as AnyRouteBuilder,

      craft()
        .id("archive_order")
        .title("Archive order")
        .description("Archive an order; requires the archivist role")
        .input({ body: z.object({ orderId: z.string() }) })
        .authorize({ roles: ["archivist"] })
        .from(mcp())
        .transform((p: { orderId: string }) => ({ archived: p.orderId }))
        .to(noop()) as AnyRouteBuilder,

      craft()
        .id("always_fails")
        .title("Always fails")
        .description("A capability whose handler throws")
        .from(mcp())
        .process(() => {
          throw new Error("upstream unavailable");
        })
        .to(noop()) as AnyRouteBuilder,
    ];
  }

  /** Boot the server with all capabilities behind RS256 JWT auth. */
  async function startSecured(): Promise<string> {
    t = await testContext()
      .routes(capabilities())
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx, {
      name: "capability-server",
      version: "1.0.0",
      transport: "http",
      port: 0,
      host: "127.0.0.1",
      auth: jwt({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      resource: { url: "https://mcp.capabilities.example/mcp" },
    });

    await t.startAndWaitReady();
    await server.start();
    return `http://127.0.0.1:${server.getHttpPort()!}/mcp`;
  }

  /** Connect a negotiating SDK client carrying the given bearer token. */
  async function connect(url: string, token: string): Promise<Client> {
    transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client(
      { name: "capability-client", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    return client;
  }

  /**
   * @case Every exposed capability is advertised with its schema and metadata
   * @preconditions Four mcp() routes with distinct titles, descriptions and input schemas, behind RS256 JWT auth; a negotiating client lists tools with a valid token
   * @expectedResult The modern era is negotiated and all four tools appear with their titles and input schemas, and the one declaring .output() advertises an outputSchema
   */
  test("advertises every capability with its schema", async () => {
    const url = await startSecured();
    const c = await connect(url, mintRs256());

    expect(c.getProtocolEra()).toBe("modern");

    const listed = await c.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual([
      "always_fails",
      "archive_order",
      "quote_total",
      "search_catalogue",
    ]);

    const search = byName.get("search_catalogue")!;
    expect(search.title).toBe("Search catalogue");
    expect(search.description).toContain("Find products");
    expect(search.inputSchema.properties).toHaveProperty("query");
    expect(search.outputSchema).toBeDefined();

    expect(byName.get("quote_total")!.inputSchema.properties).toHaveProperty(
      "lines",
    );
  }, 20_000);

  /**
   * @case A validated capability returns both text and structured content
   * @preconditions search_catalogue declares .output(); called with a query matching one product
   * @expectedResult The result carries structuredContent matching the declared output schema, alongside the text block
   */
  test("returns structured content for a capability declaring output", async () => {
    const url = await startSecured();
    const c = await connect(url, mintRs256());

    const result = await c.callTool({
      name: "search_catalogue",
      arguments: { query: "fire" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      matches: [{ sku: "RC-3", name: "Firewall", price: 340 }],
    });
  }, 20_000);

  /**
   * @case A computational capability executes its pipeline correctly
   * @preconditions quote_total called with two line items and the default VAT rate
   * @expectedResult The returned totals match the computed net, VAT and gross
   */
  test("executes a computational capability", async () => {
    const url = await startSecured();
    const c = await connect(url, mintRs256());

    const result = await c.callTool({
      name: "quote_total",
      arguments: {
        lines: [
          { price: 100, qty: 2 },
          { price: 50, qty: 1 },
        ],
      },
    });

    const content = result.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({
      net: 250,
      vat: 52.5,
      gross: 302.5,
    });
  }, 20_000);

  /**
   * @case Input validation rejects a malformed call without running the route
   * @preconditions search_catalogue declares a required non-empty query; called with an empty string
   * @expectedResult An isError result naming the validation failure rather than a successful search
   */
  test("rejects a call that fails input validation", async () => {
    const url = await startSecured();
    const c = await connect(url, mintRs256());

    const result = await c.callTool({
      name: "search_catalogue",
      arguments: { query: "" },
    });

    expect(result.isError).toBe(true);
  }, 20_000);

  /**
   * @case authorize() on a route reads the per-request principal's roles
   * @preconditions archive_order requires the archivist role; called once with a token carrying only the analyst role, then with a token carrying archivist
   * @expectedResult The analyst call is refused and the archivist call succeeds, proving the JWT claims reach route-scope authorisation on every stateless request
   */
  test("enforces route authorisation from the request's own token", async () => {
    const url = await startSecured();

    const analyst = await connect(url, mintRs256());
    const refused = await analyst.callTool({
      name: "archive_order",
      arguments: { orderId: "ord-1" },
    });
    expect(refused.isError).toBe(true);
    await analyst.close();
    await transport!.close();

    const archivist = await connect(url, mintRs256({ roles: ["archivist"] }));
    const allowed = await archivist.callTool({
      name: "archive_order",
      arguments: { orderId: "ord-1" },
    });
    expect(allowed.isError).toBeFalsy();
    const content = allowed.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ archived: "ord-1" });
  }, 20_000);

  /**
   * @case A throwing capability returns an error result instead of killing the connection
   * @preconditions always_fails throws inside its handler; called with a valid token
   * @expectedResult An isError result is returned and the same client can still call a healthy capability afterwards
   */
  test("contains a failing capability without breaking the client", async () => {
    const url = await startSecured();
    const c = await connect(url, mintRs256());

    const failed = await c.callTool({ name: "always_fails", arguments: {} });
    expect(failed.isError).toBe(true);

    const recovered = await c.callTool({
      name: "quote_total",
      arguments: { lines: [{ price: 10, qty: 1 }] },
    });
    expect(recovered.isError).toBeFalsy();
  }, 20_000);

  /**
   * @case A token signed by a different key pair is refused
   * @preconditions The server verifies against the generated public key; the client presents a token signed by a second, unrelated key pair
   * @expectedResult connect() fails, so no capability is reachable with a foreign signing key
   */
  test("refuses a token signed by a foreign key pair", async () => {
    const url = await startSecured();

    const foreign = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingInput = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      sub: "intruder",
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300,
    })}`;
    const forged = `${signingInput}.${createSign("RSA-SHA256")
      .update(signingInput)
      .sign(foreign.privateKey, "base64url")}`;

    await expect(connect(url, forged)).rejects.toThrow();
  }, 20_000);
});
