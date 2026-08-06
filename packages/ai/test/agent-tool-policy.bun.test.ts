import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, direct, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { z } from "zod";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  type AgentToolPolicy,
} from "../src/index.ts";
import {
  MCP_TOOL_REGISTRY,
  type McpToolAnnotations,
} from "../src/mcp/types.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Capture the tool map handed to the provider: it is the authoritative
// answer to "what did this agent actually get", after policy filtering
// and after loader tools are merged in.
let capturedTools: Record<string, unknown> | undefined;

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(
    async (params: { tools?: Record<string, unknown> }): Promise<LlmResult> => {
      capturedTools = params.tools;
      return { text: "done", finishReason: "stop" };
    },
  ),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

const MODEL = "anthropic:claude-opus-4-7";

function fnEntry(description: string, tags?: string[]) {
  return {
    description,
    input: z.object({}),
    handler: () => "ok",
    ...(tags ? { tags } : {}),
  };
}

/**
 * Seed the MCP tool registry directly. `mcpPlugin({ clients })`
 * populates it by connecting to a live server; these tests only need
 * the registry contents, so they write the entries a client would have
 * produced.
 */
function seedMcpRegistry(
  ctx: TestContext["ctx"],
  entries: Array<{
    name: string;
    source: string;
    annotations?: Record<string, boolean>;
  }>,
): void {
  const registry = ctx.getStore(MCP_TOOL_REGISTRY) ?? new McpToolRegistry();
  const bySource = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = bySource.get(e.source) ?? [];
    list.push(e);
    bySource.set(e.source, list);
  }
  for (const [source, list] of bySource) {
    registry.setToolsForSource(
      source,
      "stdio",
      list.map((e) => ({
        name: e.name,
        description: `MCP tool ${e.name}`,
        inputSchema: { type: "object", properties: {} },
        ...(e.annotations ? { annotations: e.annotations } : {}),
      })),
    );
  }
  ctx.setStore(MCP_TOOL_REGISTRY, registry);
}

/**
 * Build a context carrying one fn, one direct capability, and two MCP
 * client tools, under the supplied policies. Multiple policies install
 * as multiple `agentPlugin` entries so composition is exercised the way
 * a user would hit it.
 */
async function buildCtx(opts: {
  policies?: AgentToolPolicy[];
  registerAgent?: boolean;
  withBlock?: boolean;
}): Promise<TestContext> {
  const policies = opts.policies ?? [];
  const plugins = [
    llmPlugin({ providers: { anthropic: { apiKey: "test" } } }),
    agentPlugin({
      functions: {
        localFn: fnEntry("A local fn.", ["read-only"]),
        aliasedCapability: directTool("cancel-order"),
      },
      ...(opts.registerAgent
        ? {
            agents: {
              helper: {
                description: "A registered agent.",
                model: MODEL,
                system: "You are a helper.",
                tools: tools([
                  "localFn",
                  "aliasedCapability",
                  "Direct(cancel-order)",
                  "MCP(github:create_issue)",
                  "MCP(docs:search)",
                ]),
              },
            },
          }
        : {}),
      ...(policies.length > 0 ? { toolPolicy: policies[0] } : {}),
    }),
    ...policies.slice(1).map((p) => agentPlugin({ toolPolicy: p })),
  ];

  const routes = [
    craft()
      .id("cancel-order")
      .description("Cancel an order.")
      .input(z.object({}))
      .from(direct())
      .to(log()),
    craft()
      .id("inline-run")
      .from(direct())
      .to(
        agent({
          model: MODEL,
          system: "You are an inline agent.",
          tools: tools([
            "localFn",
            "aliasedCapability",
            "Direct(cancel-order)",
            "MCP(github:create_issue)",
            "MCP(docs:search)",
          ]),
          ...(opts.withBlock
            ? {
                blocks: {
                  research: {
                    mode: "progressive" as const,
                    description: "Load research notes.",
                    value: "notes",
                  },
                },
              }
            : {}),
        }),
      ),
  ];
  if (opts.registerAgent) {
    routes.push(
      craft().id("registered-run").from(direct()).to(agent("helper")),
    );
  }

  const t = await testContext().with({ plugins }).routes(routes).build();
  await t.startAndWaitReady();
  // Written after start so the entries a live MCP client would have
  // listed are present before the first agent dispatch reads them.
  seedMcpRegistry(t.ctx, [
    {
      name: "create_issue",
      source: "github",
      annotations: { destructiveHint: true },
    },
    { name: "search", source: "docs" },
  ]);
  return t;
}

/** Dispatch the inline agent and return the tool names it received. */
async function inlineAgentTools(t: TestContext): Promise<string[]> {
  await t.client.sendDirect("inline-run", { q: "x" });
  return Object.keys(capturedTools ?? {}).sort();
}

/** Dispatch the registered agent "helper" and return its tool names. */
async function registeredAgentTools(t: TestContext): Promise<string[]> {
  await t.client.sendDirect("registered-run", { q: "x" });
  return Object.keys(capturedTools ?? {}).sort();
}

const ALL_TOOLS = [
  "aliasedCapability",
  "direct__cancel-order",
  "localFn",
  "mcp__docs__search",
  "mcp__github__create_issue",
];

describe("agentPlugin({ toolPolicy }): admission control", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    capturedTools = undefined;
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case No toolPolicy leaves the agent's tool surface exactly as it was
   * @preconditions Context installs agentPlugin with no toolPolicy; agent lists every tool
   * @expectedResult All five tools reach the provider, so existing contexts are unaffected
   */
  test("absent toolPolicy admits everything", async () => {
    t = await buildCtx({});
    expect(await inlineAgentTools(t)).toEqual(ALL_TOOLS);
  });

  /**
   * @case mcp: false denies external client tools for an inline agent
   * @preconditions toolPolicy { fn: true, direct: true, mcp: false }; inline agent lists all four refs
   * @expectedResult Both mcp__ tools are dropped; fn and capability tools survive
   */
  test("mcp: false drops client tools from an inline agent", async () => {
    t = await buildCtx({
      policies: [{ fn: true, direct: true, mcp: false }],
    });
    expect(await inlineAgentTools(t)).toEqual([
      "aliasedCapability",
      "direct__cancel-order",
      "localFn",
    ]);
  });

  /**
   * @case The same policy applies to a registered (by-name) agent
   * @preconditions Same policy; agent resolved via agent("helper") from the registry
   * @expectedResult MCP tools dropped, proving no agent form opts out of the policy
   */
  test("the policy applies identically to a registered agent", async () => {
    t = await buildCtx({
      policies: [{ fn: true, direct: true, mcp: false }],
      registerAgent: true,
    });
    expect(await registeredAgentTools(t)).toEqual([
      "aliasedCapability",
      "direct__cancel-order",
      "localFn",
    ]);
  });

  /**
   * @case A denial is logged at warn naming the agent, the tool, and the kind
   * @preconditions mcp: false; registered agent "helper" dispatches
   * @expectedResult A warn line carries agent, tool, and kind so the drop is diagnosable
   */
  test("a denied tool logs a warning naming agent, tool, and kind", async () => {
    t = await buildCtx({
      policies: [{ fn: true, direct: true, mcp: false }],
      registerAgent: true,
    });
    await registeredAgentTools(t);
    const denials = t.logger.warn.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("denied by agentPlugin"),
    );
    expect(denials.length).toBe(2);
    const fields = denials.map(
      (c: unknown[]) => c[0] as Record<string, string>,
    );
    expect(fields.every((f) => f["agent"] === "helper")).toBe(true);
    expect(fields.every((f) => f["kind"] === "mcp")).toBe(true);
    expect(fields.map((f) => f["tool"]).sort()).toEqual([
      "mcp__docs__search",
      "mcp__github__create_issue",
    ]);
  });

  /**
   * @case An inline agent's denial names it as <inline> rather than dropping the field
   * @preconditions mcp: false; inline agent dispatches
   * @expectedResult The warn line still identifies the agent slot
   */
  test("an inline agent's denial is still attributable", async () => {
    t = await buildCtx({ policies: [{ fn: true, direct: true, mcp: false }] });
    await inlineAgentTools(t);
    const denial = t.logger.warn.mock.calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("denied by agentPlugin"),
    );
    expect((denial?.[0] as Record<string, string>)["agent"]).toBe("<inline>");
  });

  /**
   * @case A kind absent from a present policy is denied, not defaulted to allow
   * @preconditions toolPolicy { fn: true } only; agent lists all four refs
   * @expectedResult Only the fn survives; direct and mcp are denied by omission
   */
  test("a kind with no entry is denied", async () => {
    t = await buildCtx({ policies: [{ fn: true }] });
    expect(await inlineAgentTools(t)).toEqual(["localFn"]);
  });

  /**
   * @case An empty policy object denies every kind
   * @preconditions toolPolicy {}; agent lists all four refs
   * @expectedResult No tools reach the provider
   */
  test("an empty policy object denies everything", async () => {
    t = await buildCtx({ policies: [{}] });
    expect(await inlineAgentTools(t)).toEqual([]);
  });

  /**
   * @case An agent's own tools() selection cannot widen the policy
   * @preconditions mcp: false; the agent explicitly names both MCP tools
   * @expectedResult Explicit selection does not override the policy
   */
  test("an agent cannot override the policy by naming a tool explicitly", async () => {
    t = await buildCtx({
      policies: [{ fn: false, direct: false, mcp: false }],
    });
    expect(await inlineAgentTools(t)).toEqual([]);
  });

  /**
   * @case A directTool alias registered as a fn is governed as a capability
   * @preconditions toolPolicy { fn: true, direct: false }; agent lists the aliased capability
   * @expectedResult The alias is denied, so aliasing is not a policy bypass
   */
  test("a directTool alias is governed as direct, not as fn", async () => {
    t = await buildCtx({ policies: [{ fn: true, direct: false, mcp: false }] });
    const admitted = await inlineAgentTools(t);
    expect(admitted).toEqual(["localFn"]);
    expect(admitted).not.toContain("aliasedCapability");
  });
});

describe("agentPlugin({ toolPolicy }): predicates and composition", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    capturedTools = undefined;
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A predicate receives the descriptor and can filter on source fields
   * @preconditions mcp rule admits only the "docs" server
   * @expectedResult The docs tool survives; the github tool is dropped
   */
  test("a predicate can filter on the source discriminant", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: (tool) =>
            tool.source.kind === "mcp" && tool.source.server === "docs",
        },
      ],
    });
    expect(await inlineAgentTools(t)).toEqual([
      "aliasedCapability",
      "direct__cancel-order",
      "localFn",
      "mcp__docs__search",
    ]);
  });

  /**
   * @case A predicate sees raw MCP annotations, not only derived tags
   * @preconditions mcp rule denies anything the server flagged destructive
   * @expectedResult The annotated github tool is denied; the unannotated docs tool is admitted
   */
  test("a predicate can read raw MCP annotations", async () => {
    const seen: Array<McpToolAnnotations | undefined> = [];
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: (tool) => {
            if (tool.source.kind !== "mcp") return false;
            seen.push(tool.source.annotations);
            return tool.source.annotations?.destructiveHint !== true;
          },
        },
      ],
    });
    const admitted = await inlineAgentTools(t);
    expect(admitted).toContain("mcp__docs__search");
    expect(admitted).not.toContain("mcp__github__create_issue");
    // One entry carries the remote's hints verbatim; the other is
    // undefined because that server declared nothing. A tags-only view
    // could not tell the second case from "declared not destructive".
    expect(seen).toContainEqual({ destructiveHint: true });
    expect(seen).toContainEqual(undefined);
  });

  /**
   * @case A tool with neither tags nor annotations is denied under a positive-signal rule
   * @preconditions mcp rule requires an explicit readOnlyHint
   * @expectedResult The silent docs tool is denied, confirming fail-closed rather than fail-open
   */
  test("a tool with no tags and no annotations fails closed", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: (tool) =>
            tool.source.kind === "mcp" &&
            tool.source.annotations?.readOnlyHint === true,
        },
      ],
    });
    const admitted = await inlineAgentTools(t);
    expect(admitted).not.toContain("mcp__docs__search");
    expect(admitted).not.toContain("mcp__github__create_issue");
  });

  /**
   * @case The predicate receives the agent id for diagnostics
   * @preconditions Registered agent "helper"; rule records the ctx it was handed
   * @expectedResult agentId is the registered name
   */
  test("the rule context carries the agent id", async () => {
    const seenIds: Array<string | undefined> = [];
    t = await buildCtx({
      registerAgent: true,
      policies: [
        {
          fn: (_tool, ctx) => {
            seenIds.push(ctx.agentId);
            return true;
          },
          direct: true,
          mcp: true,
        },
      ],
    });
    await registeredAgentTools(t);
    expect(seenIds).toContain("helper");
  });

  /**
   * @case Two agentPlugin installs compose with AND
   * @preconditions One policy admits fn + direct; a second admits fn + mcp
   * @expectedResult Only fn survives, so a second install narrows and never widens
   */
  test("multiple installs compose with AND", async () => {
    t = await buildCtx({
      policies: [
        { fn: true, direct: true, mcp: false },
        { fn: true, direct: false, mcp: true },
      ],
    });
    expect(await inlineAgentTools(t)).toEqual(["localFn"]);
  });

  /**
   * @case Block loader tools bypass the policy entirely
   * @preconditions A deny-everything policy alongside a progressive block
   * @expectedResult The loader tool still reaches the provider; user tools do not
   */
  test("block loader tools are not policy-governed", async () => {
    t = await buildCtx({ policies: [{}], withBlock: true });
    expect(await inlineAgentTools(t)).toEqual(["_block__load__research"]);
  });
});

describe("agentPlugin({ toolPolicy }): construction-time validation", () => {
  /**
   * @case An unknown tool kind is rejected at construction
   * @preconditions toolPolicy carries a "block" key
   * @expectedResult agentPlugin throws RC5003 naming the valid keys
   */
  test("rejects an unknown tool kind", () => {
    expect(() =>
      agentPlugin({
        toolPolicy: { block: true } as unknown as AgentToolPolicy,
      }),
    ).toThrow(/not a known tool kind/);
  });

  /**
   * @case A non-boolean, non-function rule is rejected at construction
   * @preconditions toolPolicy.mcp is a string
   * @expectedResult agentPlugin throws RC5003 rather than silently denying at dispatch
   */
  test("rejects a rule that is neither boolean nor predicate", () => {
    expect(() =>
      agentPlugin({
        toolPolicy: { mcp: "yes" } as unknown as AgentToolPolicy,
      }),
    ).toThrow(/must be a boolean or a \(tool, ctx\) => boolean predicate/);
  });

  /**
   * @case A non-object toolPolicy is rejected at construction
   * @preconditions toolPolicy is an array
   * @expectedResult agentPlugin throws RC5003
   */
  test("rejects a non-object toolPolicy", () => {
    expect(() =>
      agentPlugin({ toolPolicy: [] as unknown as AgentToolPolicy }),
    ).toThrow(/must be an object/);
  });
});
