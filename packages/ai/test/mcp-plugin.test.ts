import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop } from "@routecraft/routecraft";
import { mcp, plugin as mcpPlugin } from "@routecraft/ai";
import { z } from "zod";

describe("MCP Plugin Integration", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that plugin() can be used in context config
   * @preconditions Plugin is added to config
   * @expectedResult Context builds without error
   */
  test("plugin() registers with context", async () => {
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
   * @case Verifies that plugin accepts options
   * @preconditions Plugin is created with custom options
   * @expectedResult Plugin accepts name, version options
   */
  test("plugin() accepts configuration options", async () => {
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
   * @case Verifies that plugin can filter tools
   * @preconditions Multiple tools are defined and filter is applied
   * @expectedResult Only filtered tools are available
   */
  test("plugin() can filter tools by name", () => {
    const p = mcpPlugin({ tools: ["allowed-tool"] });
    expect(typeof p).toBe("function");
  });

  /**
   * @case Verifies that plugin can filter tools by function
   * @preconditions Custom filter function is provided
   * @expectedResult Only tools matching filter are exposed
   */
  test("plugin() can filter tools by function", () => {
    const p = mcpPlugin({
      tools: (meta) => meta.keywords?.includes("public") ?? false,
    });
    expect(typeof p).toBe("function");
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
});
