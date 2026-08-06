import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
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
   * @case Denying every kind explicitly strips the whole surface
   * @preconditions toolPolicy with all three kinds set to false
   * @expectedResult No user tools reach the provider
   */
  test("a policy denying every kind admits nothing", async () => {
    t = await buildCtx({
      policies: [{ fn: false, direct: false, mcp: false }],
    });
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
   * @case A predicate that throws denies its tools instead of aborting the dispatch
   * @preconditions mcp rule throws; fn and direct admit
   * @expectedResult The dispatch completes, MCP tools are dropped, and the throw is logged at error
   */
  test("a throwing predicate denies rather than failing the dispatch", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: () => {
            throw new Error("policy predicate blew up");
          },
        },
      ],
    });
    const admitted = await inlineAgentTools(t);
    expect(admitted).toEqual([
      "aliasedCapability",
      "direct__cancel-order",
      "localFn",
    ]);
    // Per the boundary convention in .standards/error-and-logging-policy.md
    // the thrown message becomes the log message, so match on that
    // rather than on a framework-authored string.
    const errors = t.logger.error.mock.calls.filter(
      (c: unknown[]) => c[1] === "policy predicate blew up",
    );
    expect(errors.length).toBe(2);
    const fields = errors.map(
      (c: unknown[]) => c[0] as Record<string, unknown>,
    );
    expect(fields.every((f) => f["kind"] === "mcp")).toBe(true);
    expect(fields.every((f) => f["agent"] === "<inline>")).toBe(true);
    expect((fields[0]?.["err"] as Error).message).toBe(
      "policy predicate blew up",
    );
  });

  /**
   * @case A throwing predicate under AND composition still denies only its own kind
   * @preconditions One policy throws on fn; a second admits everything
   * @expectedResult fn tools are denied, other kinds survive, and the dispatch completes
   */
  test("a throwing predicate under AND denies only its own kind", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: () => {
            throw new Error("boom");
          },
          direct: true,
          mcp: true,
        },
        { fn: true, direct: true, mcp: true },
      ],
    });
    const admitted = await inlineAgentTools(t);
    expect(admitted).not.toContain("localFn");
    expect(admitted).toContain("direct__cancel-order");
    expect(admitted).toContain("mcp__docs__search");
  });

  /**
   * @case A throwing predicate logs once, not twice, for the same tool
   * @preconditions mcp predicate throws; both MCP tools are denied
   * @expectedResult The error line is emitted and the routine denial warning is suppressed
   */
  test("a throwing predicate does not also emit the routine denial warning", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    await inlineAgentTools(t);
    const warns = t.logger.warn.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("denied by agentPlugin"),
    );
    expect(warns.length).toBe(0);
  });

  /**
   * @case A denial is emitted on the context bus, not only logged
   * @preconditions mcp: false; a subscriber listens for route:agent:tool:denied
   * @expectedResult One event per denied tool, carrying agent, tool, kind, and reason
   */
  test("denials emit route:agent:tool:denied", async () => {
    t = await buildCtx({
      policies: [{ fn: true, direct: true, mcp: false }],
      registerAgent: true,
    });
    const seen: Array<Record<string, unknown>> = [];
    t.ctx.on("route:agent:tool:denied", ({ details }) => {
      seen.push(details as unknown as Record<string, unknown>);
    });
    await registeredAgentTools(t);
    expect(seen.length).toBe(2);
    expect(seen.every((d) => d["agentName"] === "helper")).toBe(true);
    expect(seen.every((d) => d["toolKind"] === "mcp")).toBe(true);
    expect(seen.every((d) => d["reason"] === "rule")).toBe(true);
    expect(seen.map((d) => d["toolName"]).sort()).toEqual([
      "mcp__docs__search",
      "mcp__github__create_issue",
    ]);
  });

  /**
   * @case A predicate that throws is reported with reason "rule-error"
   * @preconditions mcp predicate throws
   * @expectedResult The emitted event distinguishes a thrown rule from a rule that decided against the tool
   */
  test("a thrown predicate is reported as rule-error", async () => {
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const seen: Array<Record<string, unknown>> = [];
    t.ctx.on("route:agent:tool:denied", ({ details }) => {
      seen.push(details as unknown as Record<string, unknown>);
    });
    await inlineAgentTools(t);
    expect(seen.length).toBe(2);
    expect(seen.every((d) => d["reason"] === "rule-error")).toBe(true);
  });

  /**
   * @case The descriptor handed to a predicate cannot mutate registry state
   * @preconditions A predicate attempts to write a default onto source.annotations
   * @expectedResult The write does not reach the next dispatch's descriptor
   */
  test("the descriptor is a frozen copy, so a predicate cannot touch the registry", async () => {
    const observed: Array<boolean | undefined> = [];
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: (tool) => {
            observed.push(tool.source.annotations?.readOnlyHint);
            try {
              // A plausible accident: applying an MCP spec default.
              // Without the copy this would rewrite the registry entry
              // that also feeds the MCP server's own tools/list.
              const annotations = tool.source.annotations as
                Record<string, unknown> | undefined;
              if (annotations) annotations["readOnlyHint"] = true;
            } catch {
              // Frozen in strict mode; either outcome is acceptable so
              // long as the registry is untouched.
            }
            return true;
          },
        },
      ],
    });
    await inlineAgentTools(t);
    await inlineAgentTools(t);
    // The github tool declares destructiveHint only, so readOnlyHint is
    // absent on every dispatch unless a predicate leaked a write.
    expect(observed.every((v) => v === undefined)).toBe(true);
  });

  /**
   * @case A predicate cannot change what a later composed policy sees
   * @preconditions Two policies; the first mutates the descriptor's annotations, the second reads them
   * @expectedResult The second policy observes the original value, so AND composition does not depend on install order
   */
  test("a descriptor mutation does not leak into the next composed policy", async () => {
    const observedBySecond: Array<boolean | undefined> = [];
    t = await buildCtx({
      policies: [
        {
          fn: true,
          direct: true,
          mcp: (tool) => {
            try {
              const annotations = tool.source.annotations as
                Record<string, unknown> | undefined;
              if (annotations) annotations["destructiveHint"] = false;
            } catch {
              // Frozen; either outcome is fine so long as the next
              // policy is unaffected.
            }
            return true;
          },
        },
        {
          fn: true,
          direct: true,
          mcp: (tool) => {
            observedBySecond.push(tool.source.annotations?.destructiveHint);
            return true;
          },
        },
      ],
    });
    await inlineAgentTools(t);
    // The github tool declares destructiveHint: true. If the first
    // policy's write had landed, the second would see false.
    expect(observedBySecond).toContain(true);
    expect(observedBySecond).not.toContain(false);
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
    t = await buildCtx({
      policies: [{ fn: false, direct: false, mcp: false }],
      withBlock: true,
    });
    expect(await inlineAgentTools(t)).toEqual(["_block__load__research"]);
  });
});

describe("agentPlugin({ toolPolicy }): construction-time validation", () => {
  /**
   * @case An unknown tool kind is rejected at construction
   * @preconditions toolPolicy carries a "block" key
   * @expectedResult agentPlugin throws RC5003 naming the valid keys
   */
  /**
   * @case A policy omitting a kind is rejected at construction, not silently applied
   * @preconditions toolPolicy sets only "mcp" (the partial-adoption shape a developer reaches for first)
   * @expectedResult agentPlugin throws RC5003 naming the two kinds that were left undecided
   */
  test("rejects a policy that omits a kind", () => {
    // The type makes this a compile error; the cast reproduces what a
    // JavaScript caller (or a `as any` escape) would actually pass, and
    // proves the runtime refuses it rather than denying fn and direct
    // by omission.
    let caught: unknown;
    try {
      agentPlugin({ toolPolicy: { mcp: false } as unknown as AgentToolPolicy });
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/missing a rule for/);
    expect((caught as Error).message).toMatch(/"fn"/);
    expect((caught as Error).message).toMatch(/"direct"/);
  });

  /**
   * @case A kind present but explicitly undefined is rejected, not treated as an omission
   * @preconditions toolPolicy owns all three keys but sets mcp to undefined
   * @expectedResult agentPlugin throws RC5003, rather than silently denying every MCP tool at dispatch
   */
  test("rejects a kind whose rule is explicitly undefined", () => {
    // Owning the key satisfies the missing-key check, so without an
    // explicit rejection this would reach dispatch and be treated as a
    // denial: the exact silent strip the required keys prevent.
    let caught: unknown;
    try {
      agentPlugin({
        toolPolicy: {
          fn: true,
          direct: true,
          mcp: undefined,
        } as unknown as AgentToolPolicy,
      });
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/toolPolicy\.mcp/);
    expect((caught as Error).message).toMatch(/got undefined/);
  });

  /**
   * @case An unknown tool kind is rejected at construction
   * @preconditions A complete policy plus an extra "block" key
   * @expectedResult agentPlugin throws RC5003 naming the valid keys
   */
  test("rejects an unknown tool kind", () => {
    expect(() =>
      agentPlugin({
        toolPolicy: {
          fn: true,
          direct: true,
          mcp: true,
          block: true,
        } as unknown as AgentToolPolicy,
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
        toolPolicy: {
          fn: true,
          direct: true,
          mcp: "yes",
        } as unknown as AgentToolPolicy,
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
