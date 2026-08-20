import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  DefaultExchange,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  noop,
  type Exchange,
} from "@routecraft/routecraft";
import { suspending, testContext, type TestContext } from "@routecraft/testing";
import { McpServer } from "../src/mcp/server.ts";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
} from "../src/mcp/types.ts";
import { agent, llmPlugin, mcp } from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

// The agent-bearing advertisement test constructs (never dispatches) an
// agent route, but the barrel is mocked anyway so this file cannot leak a
// real model call if that changes.
const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

const Approval = z.object({ approved: z.boolean() });
const Payout = z.object({ paid: z.boolean() });

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Call a tool the way the SDK does, bypassing the JSON-RPC transport. */
async function callTool(
  srv: McpServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await (
    srv as unknown as {
      handleToolCall(
        tool: string,
        args: Record<string, unknown>,
        principal: undefined,
      ): Promise<ToolResult>;
    }
  ).handleToolCall(tool, args, undefined)) as ToolResult;
}

describe("MCP carries Suspended (#581)", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (t) await t.stop();
    server = undefined;
    t = undefined;
  });

  /**
   * @case A route with a static .suspend() and .output() advertises oneOf [Output, Suspended]
   * @preconditions mcp()-fronted route declaring .output(Payout) with a reachable .suspend(); the author declared only the output arm
   * @expectedResult tools/list carries outputSchema.oneOf with the payout schema first and the Suspended acknowledgment schema second (status const "suspended", required token)
   */
  test("a suspendable tool advertises the derived oneOf union", async () => {
    t = await testContext()
      .with(suspending())
      .store(MCP_STORE_KEY, true)
      .routes([
        craft()
          .id("approve-payout")
          .description("Parks for approval before paying out")
          .output({ body: Payout })
          .from<{ amount: number }>(mcp())
          .suspend({
            schema: Approval,
            meta: { channel: "finance", requires: ["payouts:approve"] },
          })
          .transform(() => ({ paid: true })),
      ])
      .build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);

    const tool = server
      .getAvailableTools()
      .find((entry) => entry.name === "approve-payout")!;
    const oneOf = tool.outputSchema?.["oneOf"] as Array<
      Record<string, unknown>
    >;
    expect(oneOf).toHaveLength(2);
    expect(oneOf[0]).toMatchObject({
      type: "object",
      properties: { paid: { type: "boolean" } },
    });
    expect(oneOf[1]).toMatchObject({
      type: "object",
      properties: { status: { const: "suspended" } },
    });
    expect((oneOf[1]!["required"] as string[]) ?? []).toContain("token");
    // Both wire enforcement points name the same key. The advertised arm is
    // closed for additional properties, so an acknowledgment carrying the
    // pre-rename `expect` would be rejected on this arm while the
    // structural fallback still accepted it, or the reverse.
    expect(
      Object.keys(oneOf[1]!["properties"] as Record<string, unknown>),
    ).toContain("schema");
    expect(tool.outputSchema?.type).toBeUndefined();
  });

  /**
   * @case A route carrying a suspend-capable agent step advertises the union too
   * @preconditions mcp()-fronted route with .output() whose pipeline dispatches an agent (its tools MAY suspend at runtime); no static .suspend() and no suspension config
   * @expectedResult The union is advertised ("may suspend" over-approximates honestly), while a plain route keeps its single-arm schema
   */
  test("an agent-bearing tool advertises the union; a plain tool does not", async () => {
    t = await testContext()
      .with({
        plugins: [llmPlugin({ providers: { anthropic: { apiKey: "sk" } } })],
      })
      .store(MCP_STORE_KEY, true)
      .routes([
        craft()
          .id("agentic")
          .description("Dispatches an agent that may park")
          .output({ body: Payout })
          .from<{ q: string }>(mcp())
          .to(agent({ model: "anthropic:claude-opus-4-7", system: "x" }))
          .transform(() => ({ paid: true })),
        craft()
          .id("plain")
          .description("Never suspends")
          .output({ body: Payout })
          .from<{ q: string }>(mcp())
          .transform(() => ({ paid: true })),
      ])
      .build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);

    const tools = server.getAvailableTools();
    const agentic = tools.find((entry) => entry.name === "agentic")!;
    expect(agentic.outputSchema?.["oneOf"]).toHaveLength(2);
    const plain = tools.find((entry) => entry.name === "plain")!;
    expect(plain.outputSchema?.["oneOf"]).toBeUndefined();
    expect(plain.outputSchema).toMatchObject({ type: "object" });
  });

  /**
   * @case A suspendable tool with no declared .output() advertises nothing
   * @preconditions mcp()-fronted suspendable route without .output()
   * @expectedResult No outputSchema: advertising a Suspended-only schema would oblige every ordinary run to carry structuredContent it does not have
   */
  test("a suspendable tool without .output() advertises no schema", async () => {
    t = await testContext()
      .with(suspending())
      .store(MCP_STORE_KEY, true)
      .routes([
        craft()
          .id("quiet")
          .description("Suspends but declares no output")
          .from<{ amount: number }>(mcp())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);

    const tool = server
      .getAvailableTools()
      .find((entry) => entry.name === "quiet")!;
    expect(tool.outputSchema).toBeUndefined();
  });

  /**
   * @case End to end: an MCP client parks a tool, resumes through an ingress route, and the original contract is honored
   * @preconditions Suspendable payout tool with .output(Payout); a direct-fronted .resume() ingress; event listeners on the plugin:mcp:tool family
   * @expectedResult The call replies isError false with the Suspended acknowledgment in structuredContent (matching the advertised second arm) and no trace of the site's meta; the record persists that meta verbatim; plugin:mcp:tool:suspended fires with the suspension id while completed/failed/declined stay silent; the resume runs execution two whose terminal body satisfies the declared output
   */
  test("park over MCP, resume through an ingress, contract honored end to end", async () => {
    const events: Array<{ name: string; detail: Record<string, unknown> }> = [];
    t = await testContext()
      .with(suspending())
      .store(MCP_STORE_KEY, true)
      .routes([
        craft()
          .id("approve-payout")
          .description("Parks for approval before paying out")
          .output({ body: Payout })
          .from<{ amount: number }>(mcp())
          .suspend({
            schema: Approval,
            meta: { channel: "finance", requires: ["payouts:approve"] },
          })
          .transform(() => ({ paid: true })),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    for (const name of [
      "plugin:mcp:tool:suspended",
      "plugin:mcp:tool:completed",
      "plugin:mcp:tool:failed",
      "plugin:mcp:tool:declined",
    ] as const) {
      t.ctx.on(name, (detail) => {
        events.push({ name, detail: detail as Record<string, unknown> });
      });
    }
    server = new McpServer(t.ctx);

    const result = await callTool(server, "approve-payout", { amount: 100 });
    expect(result.isError).toBeUndefined();
    const ack = result.structuredContent as {
      status: string;
      suspensionId: string;
      token: string;
      schema?: unknown;
    };
    expect(ack).toMatchObject({ status: "suspended" });
    expect(ack.token).toBeString();
    // The published value satisfies the advertised second arm.
    expect(ack.suspensionId).toBeString();
    expect(result.content[0]!.text).toContain('"suspended"');

    // `meta` is hook input, not wire data: it reaches the resume route's
    // authorize hook off the record and must not ride out to the MCP client,
    // which is the party that hook exists to judge.
    expect(Object.keys(ack)).not.toContain("meta");
    expect(JSON.stringify(result)).not.toContain("payouts:approve");
    const record = await t.ctx
      .getStore(SUSPENSION_RUNTIME)!
      .store.get(ack.suspensionId);
    expect(record!.meta).toEqual({
      channel: "finance",
      requires: ["payouts:approve"],
    });

    expect(events.map((e) => e.name)).toEqual(["plugin:mcp:tool:suspended"]);
    expect(events[0]!.detail["details"]).toMatchObject({
      tool: "approve-payout",
      suspensionId: ack.suspensionId,
    });

    const resumeAck = (await t.client.sendDirect("answers", {
      token: ack.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body?: unknown } };
    expect(resumeAck.status).toBe("resumed");
    expect(resumeAck.outcome.status).toBe("completed");
    expect(resumeAck.outcome.body).toEqual({ paid: true });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case The union does not weaken enforcement: a body matching neither arm is still refused
   * @preconditions A directly registered suspendable tool entry whose handler returns a body that satisfies neither the declared output nor the Suspended shape
   * @expectedResult AI2001: the call comes back isError true naming the declared output schema
   */
  test("a non-conforming body still fails AI2001 on a suspendable tool", async () => {
    t = await testContext().store(MCP_STORE_KEY, true).build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);
    const entry: McpLocalToolEntry = {
      endpoint: "junk-tool",
      description: "Returns a body neither arm accepts",
      output: { body: Payout },
      suspendable: true,
      handler: (exchange: Exchange) =>
        Promise.resolve(
          DefaultExchange.rewrap(exchange, { body: { nonsense: 1 } }),
        ),
    };
    t.ctx.setStore(MCP_LOCAL_TOOL_REGISTRY, new Map([["junk-tool", entry]]));

    const result = await callTool(server, "junk-tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/output schema/i);
  });
});
