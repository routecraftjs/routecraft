import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  HeadersKeys,
  noop,
  simple,
  type AnyRouteBuilder,
  type Exchange,
  type TraceContextMode,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mcp, tools, type FnHandlerContext } from "../src/index.ts";
import type { McpServer } from "../src/mcp/server.ts";
import type { McpPluginOptions, McpStdioToolCaller } from "../src/mcp/types.ts";
import { MCP, createMcpService } from "../src/mcp/port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { turnIdOf } from "../src/surface/cancellation.ts";
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
    headers: Record<string, string> = {},
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
        { requestInit: { headers } },
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
   * @case An authenticated tool call's trace context is adopted under the default mode
   * @preconditions An HTTP MCP server whose auth validator admits the token "good", traceContext left at its default; a tools/call with that bearer and the trace context in _meta
   * @expectedResult The exchange carries the caller's correlation id and the caller's exchange as its cause
   */
  test("server: authenticated _meta is adopted by default", async () => {
    const seen: Array<{ correlationId: string; causationId?: string }> = [];
    const c = await connect(
      {
        auth: {
          validator: (token: string) => {
            if (token !== "good") throw new Error("bad token");
            return { kind: "custom", scheme: "bearer", subject: "alice" };
          },
        },
      },
      seen,
      { Authorization: "Bearer good" },
    );
    await c.callTool({ name: "traced-tool", arguments: {}, _meta: CARRIER });
    expect(seen).toEqual([
      { correlationId: "journey-1", causationId: "exchange-9" },
    ]);
  });

  /**
   * @case An mcp() call sends the exchange's trace context, and sends none under traceContext false
   * @preconditions A stdio client recorded by a fake caller; one route enriches through mcp() with defaults, one with traceContext false
   * @expectedResult The default call's _meta carries a traceparent and an rc tracestate naming the calling exchange; the opted-out call carries no _meta
   */
  test("client: mcp() sends _meta, and none under traceContext false", async () => {
    const seen: Array<{ route: string; meta?: Record<string, string> }> = [];
    let sender = "";
    t = await testContext()
      .with({
        plugins: [
          {
            id: "test.mcp-fixture",
            provides: [MCP],
            bind(c) {
              c.provide(
                MCP,
                createMcpService({
                  stdio: new Map<string, McpStdioToolCaller>([
                    [
                      "fake",
                      {
                        async callTool() {
                          return {};
                        },
                        async callToolRaw(name, _args, meta) {
                          seen.push({ route: name, ...(meta ? { meta } : {}) });
                          return { content: [{ type: "text", text: "{}" }] };
                        },
                      },
                    ],
                  ]),
                }),
              );
            },
          },
        ],
      })
      .routes([
        craft()
          .id("calls-traced")
          .from(simple({}))
          .process((ex: Exchange) => {
            sender = ex.id;
            return ex;
          })
          .enrich(mcp({ serverId: "fake", tool: "traced" }))
          .to(noop()) as AnyRouteBuilder,
        craft()
          .id("calls-quiet")
          .from(simple({}))
          .enrich(mcp({ serverId: "fake", tool: "quiet", traceContext: false }))
          .to(noop()) as AnyRouteBuilder,
      ])
      .build();
    await t.test();

    const traced = seen.find((s) => s.route === "traced");
    expect(traced?.meta?.["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
    expect(traced?.meta?.["tracestate"]).toContain(`x:${sender}`);
    expect(seen.find((s) => s.route === "quiet")?.meta).toBeUndefined();
  });

  /**
   * @case An agent's MCP(...) tool carries the turn's journey in _meta
   * @preconditions A registered client tool resolved through tools(); its handler called with the turn's correlation and exchange ids on the handler context
   * @expectedResult The call's tracestate names the turn's correlation id and the turn's exchange
   */
  test("agent tool: MCP(...) sends the turn's trace context", async () => {
    let meta: Record<string, string> | undefined;
    const registry = new McpToolRegistry();
    registry.setToolsForSource("docs", "stdio", [
      { name: "search", inputSchema: { type: "object" } },
    ]);
    t = await testContext()
      .with({
        plugins: [
          {
            id: "test.mcp-fixture",
            provides: [MCP],
            bind(c) {
              c.provide(
                MCP,
                createMcpService({
                  tools: registry,
                  stdio: new Map<string, McpStdioToolCaller>([
                    [
                      "docs",
                      {
                        async callTool() {
                          return {};
                        },
                        async callToolRaw(_name, _args, m) {
                          meta = m;
                          return { content: [{ type: "text", text: "{}" }] };
                        },
                      },
                    ],
                  ]),
                }),
              );
            },
          },
        ],
      })
      .build();
    const [tool] = tools(["MCP(docs:search)"]).resolve(t.ctx);
    await tool!.handler({}, {
      correlationId: "turn-journey",
      exchangeId: "turn-exchange",
    } as unknown as FnHandlerContext);
    expect(meta?.["tracestate"]).toBe("rc=c:turn-journey;x:turn-exchange");
  });

  /**
   * @case A claimed correlation id does not ride an editor turn's signal
   * @preconditions Two exchanges sharing one correlation id, one marked as having joined its journey at a door
   * @expectedResult turnIdOf names the turn by correlation id for the called exchange and falls back to the session for the joined one
   */
  test("surface: a joined exchange is not the turn its correlation id names", async () => {
    t = await testContext().build();
    const { DefaultExchange } = await import("@routecraft/routecraft");
    const called = new DefaultExchange(t.ctx, {
      headers: { [HeadersKeys.CORRELATION_ID]: "turn-1" },
    });
    const joined = new DefaultExchange(t.ctx, {
      headers: {
        [HeadersKeys.CORRELATION_ID]: "turn-1",
        "routecraft.journey.joined": "door",
      },
    });
    expect(turnIdOf(called, "s")).toBe("turn-1");
    expect(turnIdOf(joined, "s")).toBe("session:s");
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
    ).toThrow(/"authenticated", "always", "never"/);
  });
});
