import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  HeadersKeys,
  noop,
  type AnyRouteBuilder,
  type Exchange,
  type TraceContextMode,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mcp } from "../src/index.ts";
import type { McpServer } from "../src/mcp/server.ts";
import type { McpPluginOptions, McpStdioToolCaller } from "../src/mcp/types.ts";
import { createMcpService } from "../src/mcp/port.ts";
import { validateMcpPluginOptions } from "../src/mcp/validate-options.ts";
import { dispatchMcpCallRaw } from "../src/mcp/dispatch.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";

const PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const CARRIER = {
  traceparent: PARENT,
  tracestate: "rc=c:journey-1;x:exchange-9",
};

describe("MCP trace context", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) await client.close();
    if (server) await server.stop();
    if (t) await t.stop();
    client = undefined;
    server = undefined;
    t = undefined;
  });

  /**
   * @case A tool call carries the trace context in _meta, unless the client is registered without it
   * @preconditions Two stdio clients recorded by a fake caller, one registered with traceContext false; dispatchMcpCallRaw called on each with a carrier
   * @expectedResult The default client receives _meta.traceparent and _meta.tracestate as given; the opted-out client receives no _meta
   */
  test("client: _meta carries the trace context; traceContext false sends none", async () => {
    const seen = new Map<string, Record<string, string> | undefined>();
    const caller = (id: string): McpStdioToolCaller => ({
      async callTool() {
        return {};
      },
      async callToolRaw(_name, _args, meta) {
        seen.set(id, meta);
        return { content: [] };
      },
    });
    const service = createMcpService({
      stdio: new Map([
        ["traced", caller("traced")],
        ["quiet", caller("quiet")],
      ]),
      clients: new Map([
        ["traced", { transport: "stdio", command: "x" }],
        ["quiet", { transport: "stdio", command: "x", traceContext: false }],
      ]),
    });

    await dispatchMcpCallRaw(service, "traced", "tool", {}, CARRIER);
    await dispatchMcpCallRaw(service, "quiet", "tool", {}, CARRIER);

    expect(seen.get("traced")).toEqual(CARRIER);
    expect(seen.get("quiet")).toBeUndefined();
  });

  async function connect(
    options: McpPluginOptions,
    seen: Array<{ correlationId: string; causationId?: string }>,
  ): Promise<Client> {
    t = await testContext()
      .with({ plugins: [mcpPort()] })
      .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
      .routes([
        craft()
          .id("traced-tool")
          .description("Records the ids it ran with")
          .input({ body: z.object({}) })
          .from(mcp())
          .process((ex: Exchange) => {
            seen.push({
              correlationId: ex.headers[HeadersKeys.CORRELATION_ID] as string,
              ...(typeof ex.headers[HeadersKeys.CAUSATION_ID] === "string"
                ? {
                    causationId: ex.headers[HeadersKeys.CAUSATION_ID] as string,
                  }
                : {}),
            });
            return ex;
          })
          .transform(() => ({ ok: true }))
          .to(noop()) as AnyRouteBuilder,
      ])
      .build();
    server = mcpServerFor(t.ctx, { transport: "http", ...options });
    await server.prepare();
    await t.startAndWaitReady();
    await server.start();
    const connected = new Client({ name: "trace-test", version: "1.0.0" });
    await connected.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.getHttpPort()}/mcp`),
      ),
    );
    client = connected;
    return connected;
  }

  /**
   * @case An unauthenticated tool call's trace context is ignored by default
   * @preconditions An HTTP MCP server with no auth; a tools/call carrying _meta.traceparent and _meta.tracestate
   * @expectedResult The exchange starts a new chain: a fresh correlation id and no cause
   */
  test("server: unauthenticated _meta is ignored by default", async () => {
    const seen: Array<{ correlationId: string; causationId?: string }> = [];
    const c = await connect({}, seen);
    await c.callTool({ name: "traced-tool", arguments: {}, _meta: CARRIER });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.correlationId).not.toBe("journey-1");
    expect(seen[0]!.causationId).toBeUndefined();
  });

  /**
   * @case A tool call's trace context is adopted under traceContext "always"
   * @preconditions An HTTP MCP server with traceContext "always"; a tools/call carrying the trace context in _meta
   * @expectedResult The exchange carries the caller's correlation id and the caller's exchange as its cause
   */
  test('server: "always" adopts _meta', async () => {
    const seen: Array<{ correlationId: string; causationId?: string }> = [];
    const c = await connect({ traceContext: "always" }, seen);
    await c.callTool({ name: "traced-tool", arguments: {}, _meta: CARRIER });
    expect(seen).toEqual([
      { correlationId: "journey-1", causationId: "exchange-9" },
    ]);
  });

  /**
   * @case mcpPlugin refuses a trace-context mode it does not know
   * @preconditions The plugin's option validation given traceContext "sometimes"
   * @expectedResult It throws naming the three accepted modes
   */
  test("server: an unknown mode is refused", () => {
    expect(() =>
      validateMcpPluginOptions({
        traceContext: "sometimes" as TraceContextMode,
      }),
    ).toThrow(/authenticated", "always" or "never"/);
  });
});
