/**
 * End-to-end coverage for the stdio MCP transport against a real spawned
 * Routecraft server.
 *
 * The HTTP suites cover the stateless revision on the wire; this one covers the
 * other serving entry, `serveStdio`, which owns the era decision for a stdio
 * connection: a negotiating client probes with `server/discover` and pins the
 * resulting era for the connection's lifetime.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER_SCRIPT = join(import.meta.dir, "fixtures", "stdio-mcp-server.ts");

describe("MCP stdio transport", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

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
  });

  /** Spawn the sample server and connect with the given negotiation mode. */
  async function connect(versionNegotiation?: {
    mode: "auto" | "legacy";
  }): Promise<Client> {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_SCRIPT],
      stderr: "pipe",
    });
    client = new Client(
      { name: "stdio-interop", version: "1.0.0" },
      {
        capabilities: {},
        ...(versionNegotiation ? { versionNegotiation } : {}),
      },
    );
    await client.connect(transport);
    return client;
  }

  /**
   * @case A negotiating client selects the modern era over stdio and calls a tool
   * @preconditions A spawned Routecraft stdio MCP server with one route; client connects with versionNegotiation mode auto
   * @expectedResult The era is "modern", tools/list reports the route, and tools/call returns the transformed payload
   */
  test("serves the modern era over stdio", async () => {
    const c = await connect({ mode: "auto" });

    expect(c.getProtocolEra()).toBe("modern");

    const listed = await c.listTools();
    expect(listed.tools.map((x) => x.name)).toContain("shout");

    const called = await c.callTool({
      name: "shout",
      arguments: { phrase: "hello" },
    });
    const content = called.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ shouted: "HELLO" });
  }, 30_000);

  /**
   * @case A 2025-era stdio client keeps working after the upgrade
   * @preconditions Same spawned server; client connects with the default (legacy) negotiation, performing the 2025 initialize handshake
   * @expectedResult The era is "legacy" and the same tool lists and calls successfully
   */
  test("still serves a 2025-era stdio client", async () => {
    const c = await connect();

    expect(c.getProtocolEra()).toBe("legacy");

    const listed = await c.listTools();
    expect(listed.tools.map((x) => x.name)).toContain("shout");

    const called = await c.callTool({
      name: "shout",
      arguments: { phrase: "compat" },
    });
    const content = called.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ shouted: "COMPAT" });
  }, 30_000);
});
