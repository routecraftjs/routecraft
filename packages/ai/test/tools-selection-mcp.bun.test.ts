import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, tools, type FnHandlerContext } from "../src/index.ts";
import { MCP_TOOL_REGISTRY } from "../src/mcp/types.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import * as realDispatchModule from "../src/mcp/dispatch.ts";

// Mock the MCP dispatch path so handlers can be exercised without
// real stdio / HTTP clients. Each test captures the recorded calls
// and asserts against them.
const recordedDispatches: Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}> = [];

const dispatchMock = mock(
  async (
    _ctx: unknown,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    recordedDispatches.push({ serverId, toolName, args });
    return { ok: true, serverId, toolName };
  },
);

// The real exports are captured above BEFORE the mock is registered. Bun
// shares one module registry across every test file in the process, so the
// mock must be restored in afterAll or it leaks into sibling files (e.g.
// mcp.bun.test.ts exercising the real dispatchMcpCall error wrapping).
const realDispatchExports = { ...realDispatchModule };
mock.module("../src/mcp/dispatch.ts", () => ({
  dispatchMcpCall: dispatchMock,
}));
afterAll(() => {
  mock.module("../src/mcp/dispatch.ts", () => realDispatchExports);
});

async function buildCtxWithMcp(
  entries: Array<{
    source: string;
    transport: "stdio" | "http" | "local";
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    }>;
  }>,
  options: {
    functions?: NonNullable<Parameters<typeof agentPlugin>[0]>["functions"];
  } = {},
): Promise<TestContext> {
  const t = await testContext()
    .with({
      plugins: [
        agentPlugin({ functions: options.functions ?? {} }),
        {
          apply(ctx) {
            const registry = new McpToolRegistry();
            for (const e of entries) {
              registry.setToolsForSource(
                e.source,
                e.transport,
                e.tools.map((tt) => ({
                  name: tt.name,
                  ...(tt.description ? { description: tt.description } : {}),
                  inputSchema: tt.inputSchema ?? { type: "object" as const },
                  ...(tt.annotations ? { annotations: tt.annotations } : {}),
                })),
              );
            }
            ctx.setStore(
              MCP_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
              registry,
            );
          },
        },
      ],
    })
    .build();
  return t;
}

describe("tools() resolver - MCP refs", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    recordedDispatches.length = 0;
    dispatchMock.mockClear();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case mcp__server__tool resolves to a single ResolvedTool
   * @preconditions Registry has Nuclino:list_teams with description and JSON Schema
   * @expectedResult Resolution yields one tool named mcp__Nuclino__list_teams whose handler dispatches through dispatchMcpCall
   */
  test("mcp__server__tool resolves to one ResolvedTool", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [
          {
            name: "list_teams",
            description: "List teams.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    const resolved = tools(["mcp__Nuclino__list_teams"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp__Nuclino__list_teams");
    expect(resolved[0]!.description).toBe("List teams.");
    await resolved[0]!.handler(
      { foo: "bar" } as unknown,
      {} as FnHandlerContext,
    );
    expect(recordedDispatches).toEqual([
      { serverId: "Nuclino", toolName: "list_teams", args: { foo: "bar" } },
    ]);
  });

  /**
   * @case mcp__server__* expands to every tool registered under the client
   * @preconditions Registry has three Nuclino tools
   * @expectedResult Resolution yields three ResolvedTools, one per registered tool, names follow mcp__Nuclino__<tool>
   */
  test("mcp__server__* expands to every tool on the client", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [
          { name: "list_teams" },
          { name: "list_workspaces" },
          { name: "search_items" },
        ],
      },
    ]);
    const resolved = tools(["mcp__Nuclino__*"]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual([
      "mcp__Nuclino__list_teams",
      "mcp__Nuclino__list_workspaces",
      "mcp__Nuclino__search_items",
    ]);
  });

  /**
   * @case Wildcard with a guard attaches the guard to every expanded tool
   * @preconditions Client with two tools; { name: "mcp__X__*", guard }
   * @expectedResult Every resolved tool carries the same guard reference
   */
  test("mcp__server__* with a guard attaches the guard to every expanded tool", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "a" }, { name: "b" }],
      },
    ]);
    const guard = mock(async () => undefined);
    const resolved = tools([{ name: "mcp__Nuclino__*", guard }]).resolve(t.ctx);
    expect(resolved).toHaveLength(2);
    for (const r of resolved) expect(r.guard).toBe(guard);
  });

  /**
   * @case MCP(server:tool) sugar resolves identically to the raw mcp__server__tool form
   * @preconditions Registry has Nuclino:list_teams
   * @expectedResult One ResolvedTool named mcp__Nuclino__list_teams whose handler dispatches through dispatchMcpCall
   */
  test("MCP(server:tool) sugar resolves to one ResolvedTool", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "list_teams", description: "List teams." }],
      },
    ]);
    const resolved = tools(["MCP(Nuclino:list_teams)"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp__Nuclino__list_teams");
    expect(resolved[0]!.description).toBe("List teams.");
    await resolved[0]!.handler(
      { foo: "bar" } as unknown,
      {} as FnHandlerContext,
    );
    expect(recordedDispatches).toEqual([
      { serverId: "Nuclino", toolName: "list_teams", args: { foo: "bar" } },
    ]);
  });

  /**
   * @case MCP(server) and raw mcp__server both expand to every tool on the server
   * @preconditions Registry has two Nuclino tools
   * @expectedResult Both forms yield the same set of mcp__Nuclino__<tool> names
   */
  test("MCP(server) and raw mcp__server expand to all server tools", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "list_teams" }, { name: "search_items" }],
      },
    ]);
    const viaSugar = tools(["MCP(Nuclino)"])
      .resolve(t.ctx)
      .map((r) => r.name)
      .sort();
    const viaRaw = tools(["mcp__Nuclino"])
      .resolve(t.ctx)
      .map((r) => r.name)
      .sort();
    expect(viaSugar).toEqual([
      "mcp__Nuclino__list_teams",
      "mcp__Nuclino__search_items",
    ]);
    expect(viaRaw).toEqual(viaSugar);
  });

  /**
   * @case MCP(server) with a guard attaches the guard to every expanded tool
   * @preconditions Server with two tools; { name: "MCP(Nuclino)", guard }
   * @expectedResult Every resolved tool carries the same guard reference
   */
  test("MCP(server) with a guard attaches the guard to every expanded tool", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "a" }, { name: "b" }],
      },
    ]);
    const guard = mock(async () => undefined);
    const resolved = tools([{ name: "MCP(Nuclino)", guard }]).resolve(t.ctx);
    expect(resolved).toHaveLength(2);
    for (const r of resolved) expect(r.guard).toBe(guard);
  });

  /**
   * @case A fn id starting with mcp__ wins over the MCP-ref grammar (exact fn id is authoritative)
   * @preconditions agentPlugin registers a fn named "mcp__health"; an MCP server is also registered
   * @expectedResult tools(["mcp__health"]) resolves the fn, not a whole-server MCP ref
   */
  test("fn id starting with mcp__ resolves via fn registry, not MCP grammar", async () => {
    t = await buildCtxWithMcp(
      [
        {
          source: "Nuclino",
          transport: "http",
          tools: [{ name: "list_teams" }],
        },
      ],
      {
        functions: {
          mcp__health: {
            description: "Ping the local mcp infra.",
            input: {
              "~standard": {
                version: 1,
                vendor: "routecraft",
                validate: (value: unknown) => ({ value }),
              },
            } as never,
            handler: async () => ({ ok: true }),
          },
        },
      },
    );
    const resolved = tools(["mcp__health"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp__health");
    expect(resolved[0]!.description).toBe("Ping the local mcp infra.");
  });

  /**
   * @case Unknown MCP client throws RC5003 listing known clients
   * @preconditions Registry has client "Nuclino"; user references "Foo"
   * @expectedResult Throw mentioning client "Foo" and listing "Nuclino"
   */
  test("unknown MCP client throws RC5003 with known clients", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "list_teams" }],
      },
    ]);
    expect(() => tools(["mcp__Foo__bar"]).resolve(t!.ctx)).toThrow(
      /client "Foo" has no registered tools.*Nuclino/s,
    );
  });

  /**
   * @case Known client with unknown tool throws and lists registered tools
   * @preconditions Registry has Nuclino:list_teams; user asks for Nuclino:nope
   * @expectedResult Throw mentions "nope" and lists "list_teams"
   */
  test("known client + unknown tool throws RC5003 listing available tools", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "list_teams" }, { name: "search_items" }],
      },
    ]);
    expect(() => tools(["mcp__Nuclino__nope"]).resolve(t!.ctx)).toThrow(
      /"nope".*list_teams.*search_items/s,
    );
  });

  /**
   * @case Client names containing underscores resolve correctly
   * @preconditions Registry has client "my_company_api"
   * @expectedResult mcp__my_company_api__get_user resolves to the right tool
   */
  test("client names with underscores resolve correctly", async () => {
    t = await buildCtxWithMcp([
      {
        source: "my_company_api",
        transport: "http",
        tools: [{ name: "get_user", description: "Get a user." }],
      },
    ]);
    const resolved = tools(["mcp__my_company_api__get_user"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp__my_company_api__get_user");
  });

  /**
   * @case A plain fn id that happens to start with "mcp_" resolves via the fn registry, not the MCP path
   * @preconditions agentPlugin registers a fn named "mcp_healthcheck"; tools(["mcp_healthcheck"])
   * @expectedResult Resolution returns the fn-registry tool; no MCP grammar error
   */
  test("mcp_-prefixed fn id without ':' resolves via fn registry", async () => {
    t = await buildCtxWithMcp([], {
      functions: {
        mcp_healthcheck: {
          description: "Ping the local mcp infra.",
          input: {
            "~standard": {
              version: 1,
              vendor: "routecraft",
              validate: (value: unknown) => ({ value }),
            },
          } as never,
          handler: async () => ({ ok: true }),
        },
      },
    });
    const resolved = tools(["mcp_healthcheck"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp_healthcheck");
  });

  /**
   * @case Malformed MCP refs with an empty server or tool segment surface as MCP grammar errors, not generic "unknown tool"
   * @preconditions Registry populated with one valid Nuclino tool; user writes `MCP(:foo)` or `MCP(foo:)`
   * @expectedResult Each throws RC5003 mentioning the MCP grammar, not "unknown tool"
   */
  test("malformed MCP refs (empty server / empty tool) emit MCP-specific errors", async () => {
    t = await buildCtxWithMcp([
      { source: "Nuclino", transport: "http", tools: [{ name: "real_tool" }] },
    ]);
    expect(() => tools(["MCP(:foo)"]).resolve(t!.ctx)).toThrow(
      /MCP reference.*empty server or tool/,
    );
    expect(() => tools(["MCP(foo:)"]).resolve(t!.ctx)).toThrow(
      /MCP reference.*empty server or tool/,
    );
  });

  /**
   * @case MCP_TOOL_REGISTRY missing throws a helpful "install mcpPlugin" error
   * @preconditions Context built without mcpPlugin; user references an MCP tool
   * @expectedResult Throw mentions install hint
   */
  test("missing MCP_TOOL_REGISTRY throws install hint", async () => {
    t = await testContext()
      .with({ plugins: [agentPlugin({})] })
      .build();
    expect(() => tools(["mcp__Foo__bar"]).resolve(t!.ctx)).toThrow(
      /no MCP_TOOL_REGISTRY is present/,
    );
  });

  /**
   * @case mcp__server__tool with description override on { name } shape throws
   * @preconditions { name: "mcp__X__y", description: "x" } in tools()
   * @expectedResult RC5003 explaining MCP descriptions are server-owned
   */
  test("description override on an MCP { name } item throws", async () => {
    t = await buildCtxWithMcp([
      { source: "X", transport: "http", tools: [{ name: "y" }] },
    ]);
    expect(() =>
      tools([{ name: "mcp__X__y", description: "override" }]).resolve(t!.ctx),
    ).toThrow(/description.*MCP server is the source of truth/);
  });

  /**
   * @case Empty-string description on an MCP { name } item throws the MCP-specific error, not the generic empty-string error
   * @preconditions { name: "mcp__X__y", description: "" } in tools()
   * @expectedResult RC5003 mentioning "MCP server is the source of truth", not "must be a non-empty string"
   */
  test("empty-string description on an MCP { name } item throws the MCP-specific error", async () => {
    t = await buildCtxWithMcp([
      { source: "X", transport: "http", tools: [{ name: "y" }] },
    ]);
    expect(() =>
      tools([{ name: "mcp__X__y", description: "" }]).resolve(t!.ctx),
    ).toThrow(/MCP server is the source of truth/);
  });

  /**
   * @case description override on an MCP wildcard { name } item throws the MCP-specific error
   * @preconditions { name: "mcp__X__*", description: "x" } in tools()
   * @expectedResult RC5003 mentioning MCP server is the source of truth
   */
  test("description override on an MCP wildcard { name } item throws", async () => {
    t = await buildCtxWithMcp([
      { source: "X", transport: "http", tools: [{ name: "y" }] },
    ]);
    expect(() =>
      tools([{ name: "mcp__X__*", description: "override" }]).resolve(t!.ctx),
    ).toThrow(/MCP server is the source of truth/);
  });

  /**
   * @case MCP tool handler rejects non-object input instead of silently coercing to {}
   * @preconditions Resolved MCP tool's handler called with null / array / number
   * @expectedResult RC5003 thrown synchronously naming the tool and the received type; dispatch never runs
   */
  test("MCP tool handler throws RC5003 on non-object input", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [
          {
            name: "search_items",
            description: "search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    const resolved = tools(["mcp__Nuclino__search_items"]).resolve(t!.ctx);
    expect(resolved).toHaveLength(1);
    const tool = resolved[0]!;
    await expect(
      tool.handler(null as unknown, {} as FnHandlerContext),
    ).rejects.toThrow(/mcp tool.*expects an object argument.*null/);
    await expect(
      tool.handler([1, 2] as unknown, {} as FnHandlerContext),
    ).rejects.toThrow(/mcp tool.*expects an object argument.*array/);
    await expect(
      tool.handler(42 as unknown, {} as FnHandlerContext),
    ).rejects.toThrow(/mcp tool.*expects an object argument.*number/);
    // Sanity: a real object argument still dispatches through.
    expect(recordedDispatches).toHaveLength(0);
  });
});
