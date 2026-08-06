import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { craft, direct, isRoutecraftError, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, directTool, tools } from "../src/index.ts";
import {
  describeToolNameViolation,
  isValidToolName,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_SEPARATOR,
} from "../src/tool-name.ts";
import { BLOCK_LOADER_PREFIX } from "../src/block/resolve.ts";
import { MCP_TOOL_REGISTRY } from "../src/mcp/types.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import {
  DIRECT_TOOL_PREFIX,
  MCP_TOOL_PREFIX,
} from "../src/agent/tools/selection.ts";

/**
 * Build a context holding one direct route with the given id, plus any
 * supplied fns. Route ids are unconstrained in core, so this happily
 * registers ids that are not valid tool names; that is the point.
 */
async function ctxWithRoute(
  routeId: string,
  functions?: NonNullable<Parameters<typeof agentPlugin>[0]>["functions"],
): Promise<TestContext> {
  const t = await testContext()
    .with({ plugins: [agentPlugin({ functions: functions ?? {} })] })
    .routes([
      craft()
        .id(routeId)
        .description("A route.")
        .input(z.object({}))
        .from(direct())
        .to(log()),
    ])
    .build();
  await t.startAndWaitReady();
  return t;
}

describe("tool-name contract: shared constants", () => {
  /**
   * @case Every synthetic prefix uses `__` as its only structural separator
   * @preconditions Import the direct, MCP, and block-loader prefixes
   * @expectedResult Each ends with `__` and contains no internal `__` before that boundary
   */
  test("synthetic prefixes use `__` as the sole structural separator", () => {
    for (const prefix of [
      DIRECT_TOOL_PREFIX,
      MCP_TOOL_PREFIX,
      BLOCK_LOADER_PREFIX,
    ]) {
      expect(prefix.endsWith(TOOL_NAME_SEPARATOR)).toBe(true);
      // Strip the trailing boundary, then assert the remaining prefix
      // body has no `__` inside a segment beyond its own kind markers.
      // Splitting on `__` must yield only non-empty segments, which is
      // what keeps a boundary findable by scanning for `__`.
      const segments = prefix
        .slice(0, -TOOL_NAME_SEPARATOR.length)
        .split(TOOL_NAME_SEPARATOR);
      for (const segment of segments) expect(segment.length).toBeGreaterThan(0);
    }
  });

  /**
   * @case The concrete prefixes are the documented wire forms
   * @preconditions Import the three prefixes
   * @expectedResult direct__, mcp__, and _block__load__ exactly
   */
  test("prefixes are the documented wire forms", () => {
    expect(DIRECT_TOOL_PREFIX).toBe("direct__");
    expect(MCP_TOOL_PREFIX).toBe("mcp__");
    expect(BLOCK_LOADER_PREFIX).toBe("_block__load__");
  });

  /**
   * @case describeToolNameViolation reports length before charset
   * @preconditions A name that is both over-long and contains a colon
   * @expectedResult The reported reason names the length, not the character
   */
  test("violation reporting prefers the structural reason", () => {
    const tooLong = `${"a".repeat(TOOL_NAME_MAX_LENGTH)}:x`;
    expect(describeToolNameViolation(tooLong)).toMatch(/characters, over/);
    expect(describeToolNameViolation("has:colon")).toMatch(/":"/);
    expect(describeToolNameViolation("")).toMatch(/empty/);
    // A non-BMP character is one character to the author, so report it
    // as one rather than as the two surrogate halves it is stored as.
    expect(describeToolNameViolation("emoji\u{1F600}")).toMatch(/"\u{1F600}"/u);
    expect(describeToolNameViolation("fine-name_1")).toBeUndefined();
    expect(isValidToolName("fine-name_1")).toBe(true);
    expect(isValidToolName("has:colon")).toBe(false);
  });
});

describe("Direct(<routeId>) tool-name validation", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A colon-bearing route id is rejected rather than reaching the provider
   * @preconditions Route registered as "memory:get" (the documented BlockClient.forward convention)
   * @expectedResult RC5003 naming the derived tool name, the offending character, and the directTool escape hatch
   */
  test("rejects a colon-bearing route id", async () => {
    t = await ctxWithRoute("memory:get");
    let caught: unknown;
    try {
      tools(["Direct(memory:get)"]).resolve(t.ctx);
    } catch (err) {
      caught = err;
    }
    expect(isRoutecraftError(caught)).toBe(true);
    expect((caught as { rc?: string }).rc).toBe("RC5003");
    const message = (caught as Error).message;
    expect(message).toMatch(/direct__memory:get/);
    expect(message).toMatch(/":"/);
    const suggestion = (caught as { meta?: { suggestion?: string } }).meta
      ?.suggestion;
    expect(suggestion).toMatch(/directTool\("memory:get"\)/);
  });

  /**
   * @case A route id containing a slash is rejected on the same path
   * @preconditions Route registered as "orders/cancel"
   * @expectedResult RC5003 naming the "/" character
   */
  test("rejects a slash-bearing route id", async () => {
    t = await ctxWithRoute("orders/cancel");
    expect(() => tools(["Direct(orders/cancel)"]).resolve(t!.ctx)).toThrow(
      /"\/"/,
    );
  });

  /**
   * @case The 64-character ceiling is enforced on the prefixed name, not the bare route id
   * @preconditions Route id is 57 chars: legal alone, but 65 once "direct__" is prepended
   * @expectedResult RC5003 reporting 65 characters against the provider limit
   */
  test("enforces the length ceiling after the prefix is applied", async () => {
    const routeId = "a".repeat(
      TOOL_NAME_MAX_LENGTH - DIRECT_TOOL_PREFIX.length + 1,
    );
    expect(isValidToolName(routeId)).toBe(true);
    t = await ctxWithRoute(routeId);
    expect(() => tools([`Direct(${routeId})`]).resolve(t!.ctx)).toThrow(
      new RegExp(
        `65 characters, over the provider limit of ${TOOL_NAME_MAX_LENGTH}`,
      ),
    );
  });

  /**
   * @case A route id that exactly fills the budget is accepted
   * @preconditions Route id is 56 chars, making the tool name exactly 64
   * @expectedResult Resolution succeeds and the name is exactly at the limit
   */
  test("accepts a route id that exactly fills the length budget", async () => {
    const routeId = "a".repeat(
      TOOL_NAME_MAX_LENGTH - DIRECT_TOOL_PREFIX.length,
    );
    t = await ctxWithRoute(routeId);
    const [resolved] = tools([`Direct(${routeId})`]).resolve(t.ctx);
    expect(resolved.name).toHaveLength(TOOL_NAME_MAX_LENGTH);
    expect(isValidToolName(resolved.name)).toBe(true);
  });

  /**
   * @case The documented escape hatch exposes an unsafe route id under a clean name
   * @preconditions Route "memory:get" registered and aliased via directTool under fn id "memoryGet"
   * @expectedResult The alias resolves, carrying the route's description, with a tool-safe name
   */
  test("directTool aliases an unsafe route id to a tool-safe name", async () => {
    t = await ctxWithRoute("memory:get", {
      memoryGet: directTool("memory:get"),
    });
    const [resolved] = tools(["memoryGet"]).resolve(t.ctx);
    expect(resolved.name).toBe("memoryGet");
    expect(resolved.description).toBe("A route.");
    expect(isValidToolName(resolved.name)).toBe(true);
  });
});

describe("MCP client tool-name validation", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A remote tool whose composed wire name is invalid is dropped, not thrown
   * @preconditions A client exposes one tool-safe name and one with a dot in it
   * @expectedResult The safe tool resolves, the unsafe one is absent, and a warning names it
   */
  test("drops a remote tool whose wire name is unusable", async () => {
    t = await testContext().build();
    const registry = new McpToolRegistry();
    registry.setToolsForSource("github", "stdio", [
      { name: "list_issues", inputSchema: { type: "object", properties: {} } },
      // A remote is free to name its tools anything; we are not.
      {
        name: "issues.create",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    t.ctx.setStore(MCP_TOOL_REGISTRY, registry);

    const resolved = tools(["MCP(github)"]).resolve(t.ctx);
    expect(resolved.map((r) => r.name)).toEqual(["mcp__github__list_issues"]);

    const warned = t.logger.warn.mock.calls.some(
      (c: unknown[]) =>
        typeof c[1] === "string" &&
        c[1].includes("not usable as a provider tool name"),
    );
    expect(warned).toBe(true);
  });

  /**
   * @case An explicitly named remote tool with an unusable name is also dropped, not thrown
   * @preconditions The agent names the offending tool directly rather than via a wildcard
   * @expectedResult Resolution returns no tool and does not throw, so one bad remote name cannot fail every dispatch
   */
  test("dropping applies to an explicit reference too", async () => {
    t = await testContext().build();
    const registry = new McpToolRegistry();
    registry.setToolsForSource("github", "stdio", [
      {
        name: "issues.create",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    t.ctx.setStore(MCP_TOOL_REGISTRY, registry);

    expect(tools(["MCP(github:issues.create)"]).resolve(t.ctx)).toEqual([]);
  });

  /**
   * @case The length ceiling applies to the composed mcp__ name, not the remote name alone
   * @preconditions Server and tool names are individually legal but overrun 64 once joined
   * @expectedResult The tool is dropped with a length-based reason
   */
  test("enforces the ceiling on the composed name", async () => {
    t = await testContext().build();
    const registry = new McpToolRegistry();
    const longTool = "a".repeat(60);
    registry.setToolsForSource("github", "stdio", [
      { name: longTool, inputSchema: { type: "object", properties: {} } },
    ]);
    t.ctx.setStore(MCP_TOOL_REGISTRY, registry);

    expect(tools(["MCP(github)"]).resolve(t.ctx)).toEqual([]);
    const warned = t.logger.warn.mock.calls.some(
      (c: unknown[]) =>
        typeof c[1] === "string" &&
        c[1].includes(`over the provider limit of ${TOOL_NAME_MAX_LENGTH}`),
    );
    expect(warned).toBe(true);
  });
});

describe("fn id tool-name validation", () => {
  /**
   * @case A fn id that is not a valid tool name fails at registration, not at the provider
   * @preconditions agentPlugin registers a fn keyed "my:fn"
   * @expectedResult Context build throws RC5003 naming the id and the constraint
   */
  test("rejects a fn id outside the provider charset", async () => {
    await expect(
      testContext()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                "my:fn": {
                  description: "A fn.",
                  input: z.object({}),
                  handler: () => "x",
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/fn id "my:fn" is not usable as a tool name/);
  });

  /**
   * @case An over-long fn id is rejected with the length reason
   * @preconditions agentPlugin registers a fn whose id is 65 characters
   * @expectedResult Context build throws RC5003 reporting the provider limit
   */
  test("rejects an over-long fn id", async () => {
    await expect(
      testContext()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                ["a".repeat(TOOL_NAME_MAX_LENGTH + 1)]: {
                  description: "A fn.",
                  input: z.object({}),
                  handler: () => "x",
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(
      new RegExp(`over the provider limit of ${TOOL_NAME_MAX_LENGTH}`),
    );
  });
});
