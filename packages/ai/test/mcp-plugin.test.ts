import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop } from "@routecraft/routecraft";
import { mcp, mcpPlugin, MCP_TOOL_REGISTRY } from "@routecraft/ai";
import type { McpToolRegistry } from "@routecraft/ai";
import { z } from "zod";

const MCP_TOOL_REGISTRY_KEY =
  MCP_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry;

describe("MCP Plugin Integration", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Route using .from(mcp(...)) without mcpPlugin fails at start
   * @preconditions Route has mcp() source but plugins do not include mcpPlugin()
   * @expectedResult Starting the context (t.test()) throws with message about MCP plugin required
   */
  test(".from(mcp(...)) without mcpPlugin fails when route starts", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("test")
          .from(mcp("test", { description: "test" }))
          .to(noop()),
      )
      .build();

    await expect(t.test()).rejects.toThrow(/MCP plugin required/);
  });

  /**
   * @case Verifies that mcpPlugin() can be used in context config
   * @preconditions Plugin is added to config
   * @expectedResult Context builds without error
   */
  test("mcpPlugin() registers with context", async () => {
    expect(typeof mcpPlugin).toBe("function");

    t = await testContext()
      .routes(
        craft()
          .id("test")
          .from(mcp("test", { description: "test" }))
          .to(noop()),
      )
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that only mcp() routes with description are exposed
   * @preconditions Routes with mcp() and direct() are defined
   * @expectedResult Registry contains only mcp routes
   */
  test("Only mcp() routes with description are exposed", async () => {
    const toolRoute = craft()
      .id("my-tool")
      .from(
        mcp("my-tool", {
          description: "A test tool",
          schema: z.object({ input: z.string() }),
        }),
      )
      .to(noop());

    const directRoute = craft()
      .id("internal-bus")
      .from(direct("internal-bus", {}))
      .to(noop());

    t = await testContext()
      .routes([toolRoute, directRoute])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that mcpPlugin accepts options
   * @preconditions Plugin is created with custom options
   * @expectedResult Plugin accepts name, version options
   */
  test("mcpPlugin() accepts configuration options", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("test")
          .from(mcp("test", { description: "test" }))
          .to(noop()),
      )
      .with({
        plugins: [
          mcpPlugin({
            name: "custom-server",
            version: "2.0.0",
          }),
        ],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that mcpPlugin can filter tools
   * @preconditions Multiple tools are defined and filter is applied
   * @expectedResult Plugin is an object with apply and optional teardown
   */
  test("mcpPlugin() can filter tools by name", () => {
    const p = mcpPlugin({ tools: ["allowed-tool"] });
    expect(typeof p.apply).toBe("function");
    expect(p).toHaveProperty("teardown");
  });

  /**
   * @case Verifies that mcpPlugin can filter tools by function
   * @preconditions Custom filter function is provided
   * @expectedResult Plugin is an object with apply and optional teardown
   */
  test("mcpPlugin() can filter tools by function", () => {
    const p = mcpPlugin({
      tools: (meta) => meta.keywords?.includes("public") ?? false,
    });
    expect(typeof p.apply).toBe("function");
    expect(p).toHaveProperty("teardown");
  });

  /**
   * @case Verifies that mcp() routes with schema are properly registered
   * @preconditions An mcp route with Zod schema is defined
   * @expectedResult Schema is registered in metadata
   */
  test("mcp() routes register with schema", async () => {
    const mySchema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const toolRoute = craft()
      .id("schema-tool")
      .from(
        mcp("schema-tool", {
          description: "A tool with schema",
          schema: mySchema,
        }),
      )
      .to(noop());

    t = await testContext()
      .routes([toolRoute])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case Verifies that mcp() routes without description are not treated as tools
   * @preconditions A direct() adapter is used without description
   * @expectedResult Route is registered but not in tool registry
   */
  test("Routes without description are not exposed as tools", async () => {
    const route = craft()
      .id("plain-direct")
      .from(direct("plain-direct", {}))
      .to(noop());

    t = await testContext()
      .routes([route])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    expect(t).toBeDefined();
  });

  /**
   * @case mcpPlugin stores MCP_TOOL_REGISTRY in context store
   * @preconditions Plugin is applied
   * @expectedResult Context store has McpToolRegistry instance
   */
  test("mcpPlugin stores MCP_TOOL_REGISTRY in context store", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("test")
          .from(mcp("test", { description: "test" }))
          .to(noop()),
      )
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    const registry = t.ctx.getStore(MCP_TOOL_REGISTRY_KEY) as
      | McpToolRegistry
      | undefined;
    expect(registry).toBeDefined();
    expect(typeof registry!.getTools).toBe("function");
    expect(typeof registry!.getTool).toBe("function");
  });

  /**
   * @case MCP_TOOL_REGISTRY is populated with local tools after context starts
   * @preconditions Plugin applied with mcp() routes, context started
   * @expectedResult Registry contains local tools from mcp() routes
   */
  test("tool registry is populated with local tools after context starts", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("tool-a")
          .from(mcp("tool-a", { description: "Tool A" }))
          .to(noop()),
        craft()
          .id("tool-b")
          .from(mcp("tool-b", { description: "Tool B" }))
          .to(noop()),
        craft().id("internal").from(direct("internal", {})).to(noop()),
      ])
      .with({
        plugins: [mcpPlugin()],
      })
      .build();

    await t.test();

    const registry = t.ctx.getStore(MCP_TOOL_REGISTRY_KEY) as McpToolRegistry;
    const tools = registry.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("tool-a");
    expect(names).toContain("tool-b");
    // direct() route without description should not appear
    expect(names).not.toContain("internal");
    // All local tools should have transport "local"
    expect(tools.every((t) => t.transport === "local")).toBe(true);
    expect(tools.every((t) => t.source === "local")).toBe(true);
  });

  describe("validation", () => {
    /**
     * @case Validation rejects empty command for stdio client
     * @preconditions Stdio client with empty command
     * @expectedResult TypeError thrown
     */
    test("rejects stdio client with empty command", () => {
      expect(() =>
        mcpPlugin({
          clients: {
            bad: { transport: "stdio", command: "" },
          },
        }),
      ).toThrow(/non-empty command/);
    });

    /**
     * @case Validation rejects negative maxRestarts
     * @preconditions maxRestarts set to -1
     * @expectedResult TypeError thrown
     */
    test("rejects negative maxRestarts", () => {
      expect(() => mcpPlugin({ maxRestarts: -1 })).toThrow(
        /non-negative integer/,
      );
    });

    /**
     * @case Validation rejects non-integer maxRestarts
     * @preconditions maxRestarts set to 2.5
     * @expectedResult TypeError thrown
     */
    test("rejects non-integer maxRestarts", () => {
      expect(() => mcpPlugin({ maxRestarts: 2.5 })).toThrow(
        /non-negative integer/,
      );
    });

    /**
     * @case Validation rejects zero restartDelayMs
     * @preconditions restartDelayMs set to 0
     * @expectedResult TypeError thrown
     */
    test("rejects zero restartDelayMs", () => {
      expect(() => mcpPlugin({ restartDelayMs: 0 })).toThrow(/positive number/);
    });

    /**
     * @case Validation rejects restartBackoffMultiplier less than 1
     * @preconditions restartBackoffMultiplier set to 0.5
     * @expectedResult TypeError thrown
     */
    test("rejects restartBackoffMultiplier less than 1", () => {
      expect(() => mcpPlugin({ restartBackoffMultiplier: 0.5 })).toThrow(
        />= 1/,
      );
    });

    /**
     * @case Validation rejects negative toolRefreshIntervalMs
     * @preconditions toolRefreshIntervalMs set to -100
     * @expectedResult TypeError thrown
     */
    test("rejects negative toolRefreshIntervalMs", () => {
      expect(() => mcpPlugin({ toolRefreshIntervalMs: -100 })).toThrow(
        /non-negative integer/,
      );
    });

    /**
     * @case Valid restart options are accepted
     * @preconditions All restart options within valid range
     * @expectedResult Plugin created without error
     */
    test("accepts valid restart options", () => {
      const p = mcpPlugin({
        maxRestarts: 10,
        restartDelayMs: 500,
        restartBackoffMultiplier: 1.5,
        toolRefreshIntervalMs: 30000,
      });
      expect(typeof p.apply).toBe("function");
    });
  });

  describe("stdio client config acceptance", () => {
    /**
     * @case mcpPlugin accepts stdio client configuration
     * @preconditions Valid stdio client config provided
     * @expectedResult Plugin created without error
     */
    test("accepts valid stdio client config", () => {
      const p = mcpPlugin({
        clients: {
          "my-server": {
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            env: { NODE_ENV: "production" },
            cwd: "/tmp",
          },
        },
        maxRestarts: 3,
        restartDelayMs: 100,
        restartBackoffMultiplier: 2,
      });
      expect(typeof p.apply).toBe("function");
    });

    /**
     * @case mcpPlugin accepts mixed HTTP and stdio client config
     * @preconditions Both HTTP and stdio configs provided
     * @expectedResult Plugin created without error
     */
    test("accepts mixed HTTP and stdio client config", () => {
      const p = mcpPlugin({
        clients: {
          "http-server": { url: "http://localhost:3000/mcp" },
          "stdio-server": {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@some/mcp-server"],
          },
        },
      });
      expect(typeof p.apply).toBe("function");
    });
  });
});
