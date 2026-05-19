import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  defaultFns,
  MCP_TOOL_REGISTRY,
  tools,
  type FnHandlerContext,
} from "../src/index.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";

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

mock.module("../src/mcp/dispatch.ts", () => ({
  dispatchMcpCall: dispatchMock,
}));

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
   * @case mcp_<client>:<tool> resolves to a single ResolvedTool
   * @preconditions Registry has Nuclino:list_teams with description and JSON Schema
   * @expectedResult Resolution yields one tool named mcp_Nuclino:list_teams whose handler dispatches through dispatchMcpCall
   */
  test("mcp_<client>:<tool> resolves to one ResolvedTool", async () => {
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
    const resolved = tools(["mcp_Nuclino:list_teams"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp_Nuclino:list_teams");
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
   * @case mcp_<client>:* expands to every tool registered under the client
   * @preconditions Registry has three Nuclino tools
   * @expectedResult Resolution yields three ResolvedTools, one per registered tool, names follow mcp_Nuclino:<tool>
   */
  test("mcp_<client>:* expands to every tool on the client", async () => {
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
    const resolved = tools(["mcp_Nuclino:*"]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual([
      "mcp_Nuclino:list_teams",
      "mcp_Nuclino:list_workspaces",
      "mcp_Nuclino:search_items",
    ]);
  });

  /**
   * @case Wildcard with a guard attaches the guard to every expanded tool
   * @preconditions Client with two tools; { name: "mcp_X:*", guard }
   * @expectedResult Every resolved tool carries the same guard reference
   */
  test("mcp_<client>:* with a guard attaches the guard to every expanded tool", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "a" }, { name: "b" }],
      },
    ]);
    const guard = mock(async () => undefined);
    const resolved = tools([{ name: "mcp_Nuclino:*", guard }]).resolve(t.ctx);
    expect(resolved).toHaveLength(2);
    for (const r of resolved) expect(r.guard).toBe(guard);
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
    expect(() => tools(["mcp_Foo:bar"]).resolve(t!.ctx)).toThrow(
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
    expect(() => tools(["mcp_Nuclino:nope"]).resolve(t!.ctx)).toThrow(
      /"nope".*list_teams.*search_items/s,
    );
  });

  /**
   * @case Client names containing underscores resolve correctly
   * @preconditions Registry has client "my_company_api"
   * @expectedResult mcp_my_company_api:get_user resolves to the right tool
   */
  test("client names with underscores resolve correctly", async () => {
    t = await buildCtxWithMcp([
      {
        source: "my_company_api",
        transport: "http",
        tools: [{ name: "get_user", description: "Get a user." }],
      },
    ]);
    const resolved = tools(["mcp_my_company_api:get_user"]).resolve(t.ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("mcp_my_company_api:get_user");
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
   * @case Malformed MCP refs with an empty client or tool segment surface as MCP grammar errors, not generic "unknown tool"
   * @preconditions Registry populated with one valid Nuclino tool; user writes `mcp_:foo` or `mcp_foo:`
   * @expectedResult Each throws RC5003 mentioning the MCP grammar (form "mcp_<client>:<tool>"), not "unknown tool"
   */
  test("malformed mcp_ refs (empty client / empty tool) emit MCP-specific errors", async () => {
    t = await buildCtxWithMcp([
      { source: "Nuclino", transport: "http", tools: [{ name: "real_tool" }] },
    ]);
    expect(() => tools(["mcp_:foo"]).resolve(t!.ctx)).toThrow(
      /MCP reference.*form "mcp_<client>:<tool>".*empty client or tool/,
    );
    expect(() => tools(["mcp_foo:"]).resolve(t!.ctx)).toThrow(
      /MCP reference.*form "mcp_<client>:<tool>".*empty client or tool/,
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
    expect(() => tools(["mcp_Foo:bar"]).resolve(t!.ctx)).toThrow(
      /no MCP_TOOL_REGISTRY is present/,
    );
  });

  /**
   * @case mcp_<client>:<tool> with description override on { name } shape throws
   * @preconditions { name: "mcp_X:y", description: "x" } in tools()
   * @expectedResult RC5003 explaining MCP descriptions are server-owned
   */
  test("description override on an MCP { name } item throws", async () => {
    t = await buildCtxWithMcp([
      { source: "X", transport: "http", tools: [{ name: "y" }] },
    ]);
    expect(() =>
      tools([{ name: "mcp_X:y", description: "override" }]).resolve(t!.ctx),
    ).toThrow(/description.*MCP server is the source of truth/);
  });
});

describe("tools() resolver - { tagged, from? } over MCP", () => {
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
   * @case `{ tagged: "read-only" }` walks fns AND MCP tools in one selection
   * @preconditions defaultFns provides currentTime ("read-only"); registry has Nuclino:get_item with readOnlyHint
   * @expectedResult Both tools appear in the resolved list
   */
  test("{ tagged } walks fns and MCP tools together", async () => {
    t = await buildCtxWithMcp(
      [
        {
          source: "Nuclino",
          transport: "http",
          tools: [{ name: "get_item", annotations: { readOnlyHint: true } }],
        },
      ],
      { functions: { ...defaultFns } },
    );
    const resolved = tools([{ tagged: "read-only" }]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toContain("currentTime");
    expect(names).toContain("mcp_Nuclino:get_item");
  });

  /**
   * @case `from: "mcp_<client>"` scopes the tag selector to one MCP client
   * @preconditions defaultFns ships read-only fns; registry has Nuclino read-only tool and Stripe read-only tool
   * @expectedResult Only Nuclino's read-only tool appears; defaultFns and Stripe are excluded
   */
  test("{ tagged, from } scopes to a single MCP client", async () => {
    t = await buildCtxWithMcp(
      [
        {
          source: "Nuclino",
          transport: "http",
          tools: [{ name: "get_item", annotations: { readOnlyHint: true } }],
        },
        {
          source: "Stripe",
          transport: "http",
          tools: [
            { name: "list_charges", annotations: { readOnlyHint: true } },
          ],
        },
      ],
      { functions: { ...defaultFns } },
    );
    const resolved = tools([
      { tagged: "read-only", from: "mcp_Nuclino" },
    ]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual(["mcp_Nuclino:get_item"]);
  });

  /**
   * @case `from: "mcp_<unknown>"` throws RC5003 listing registered clients
   * @preconditions Registry has Nuclino only; user scopes from "mcp_Foo"
   * @expectedResult Throw mentions "mcp_Foo" and lists "Nuclino"
   */
  test("{ tagged, from } against an unknown MCP client throws", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [{ name: "get_item", annotations: { readOnlyHint: true } }],
      },
    ]);
    expect(() =>
      tools([{ tagged: "read-only", from: "mcp_Foo" }]).resolve(t!.ctx),
    ).toThrow(/mcp_Foo.*Nuclino/s);
  });

  /**
   * @case Zero-match `{ tagged, from }` throws so a misconfig never silently no-ops
   * @preconditions Nuclino has a destructive tool only; user filters for "read-only"
   * @expectedResult RC5003 thrown
   */
  test("{ tagged, from } that matches zero tools throws RC5003", async () => {
    t = await buildCtxWithMcp([
      {
        source: "Nuclino",
        transport: "http",
        tools: [
          { name: "delete_team", annotations: { destructiveHint: true } },
        ],
      },
    ]);
    expect(() =>
      tools([{ tagged: "read-only", from: "mcp_Nuclino" }]).resolve(t!.ctx),
    ).toThrow(/matched no tools/);
  });

  /**
   * @case Mixed selection of MCP wildcard, MCP scoped tag, fn, and direct in one array
   * @preconditions Two MCP tools (one read-only, one destructive); two defaultFns
   * @expectedResult Resolved list contains the wildcard expansion + the tag-filtered subset + the explicit fn, deduped
   */
  test("mixes MCP refs, tag filters, and fn names in one selection", async () => {
    t = await buildCtxWithMcp(
      [
        {
          source: "Nuclino",
          transport: "http",
          tools: [
            { name: "get_item", annotations: { readOnlyHint: true } },
            { name: "delete_item", annotations: { destructiveHint: true } },
          ],
        },
      ],
      { functions: { ...defaultFns } },
    );
    const resolved = tools([
      "mcp_Nuclino:*",
      { tagged: "destructive", from: "mcp_Nuclino" },
      "currentTime",
    ]).resolve(t.ctx);
    const names = resolved.map((r) => r.name).sort();
    expect(names).toEqual([
      "currentTime",
      "mcp_Nuclino:delete_item",
      "mcp_Nuclino:get_item",
    ]);
  });
});
