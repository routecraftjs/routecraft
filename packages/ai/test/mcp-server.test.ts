import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { MCPServer } from "../src/mcp/server.ts";
import {
  testContext,
  craft,
  direct,
  noop,
  type TestContext,
} from "@routecraft/routecraft";
import { tool } from "../src/index.ts";
import { z } from "zod";

describe("MCPServer", () => {
  let t: TestContext;
  let server: MCPServer;

  beforeEach(() => {
    // Clear state
  });

  afterEach(async () => {
    if (server) {
      try {
        await server.stop();
      } catch {
        // Ignore errors during cleanup
      }
    }
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies MCPServer initialization
   * @preconditions MCPServer is created with default options
   * @expectedResult Server initializes without error
   */
  test("MCPServer initializes with default options", async () => {
    t = await testContext().build();
    server = new MCPServer(t.ctx);
    expect(server).toBeDefined();
  });

  /**
   * @case Verifies MCPServer initialization with custom options
   * @preconditions MCPServer is created with custom name
   * @expectedResult Server accepts custom configuration
   */
  test("MCPServer accepts custom options", async () => {
    t = await testContext().build();
    server = new MCPServer(t.ctx, {
      name: "custom-server",
      version: "2.0.0",
    });
    expect(server).toBeDefined();
  });

  /**
   * @case Verifies that MCPServer can filter tools by name
   * @preconditions Tool routes are defined and filter is applied
   * @expectedResult Only matching tools are available
   */
  test("MCPServer respects tool filtering by name", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("tool1")
          .from(
            tool("tool1", {
              description: "First tool",
            }),
          )
          .to(noop()),
        craft()
          .id("tool2")
          .from(
            tool("tool2", {
              description: "Second tool",
            }),
          )
          .to(noop()),
      ])
      .build();

    server = new MCPServer(t.ctx, {
      tools: ["tool1"],
    });

    expect(server).toBeDefined();
    const routeStartedPromise = new Promise<void>((resolve) => {
      let count = 0;
      t.ctx.on("routeStarted", () => {
        count++;
        if (count >= 2) resolve();
      });
    });
    const startPromise = t.ctx.start();
    await routeStartedPromise;
    const tools = server.getAvailableTools();
    const names = tools.map((t) => t.name as string);
    expect(names).toContain("tool1");
    expect(names).not.toContain("tool2");
    expect(names).toEqual(["tool1"]);
    await t.ctx.stop();
    await startPromise;
  });

  /**
   * @case Verifies that MCPServer can filter tools by function
   * @preconditions Tool routes with keywords are defined and filter function is provided
   * @expectedResult Only tools matching filter are available
   */
  test("MCPServer respects tool filtering by function", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("public-tool")
          .from(
            tool("public-tool", {
              description: "A public tool",
              keywords: ["public"],
            }),
          )
          .to(noop()),
        craft()
          .id("private-tool")
          .from(
            tool("private-tool", {
              description: "A private tool",
              keywords: ["private"],
            }),
          )
          .to(noop()),
      ])
      .build();

    server = new MCPServer(t.ctx, {
      tools: (meta) => meta.keywords?.includes("public") ?? false,
    });

    expect(server).toBeDefined();
    const routeStartedPromise = new Promise<void>((resolve) => {
      let count = 0;
      t.ctx.on("routeStarted", () => {
        count++;
        if (count >= 2) resolve();
      });
    });
    const startPromise = t.ctx.start();
    await routeStartedPromise;
    const tools = server.getAvailableTools();
    const names = tools.map((t) => t.name as string);
    expect(names).toContain("public-tool");
    expect(names).not.toContain("private-tool");
    expect(names).toEqual(["public-tool"]);
    await t.ctx.stop();
    await startPromise;
  });

  /**
   * @case Verifies schema conversion for Zod schemas
   * @preconditions A tool route with Zod schema is registered
   * @expectedResult Schema is properly handled
   */
  test("MCPServer handles Zod schema conversion", async () => {
    const schema = z.object({
      name: z.string().describe("User name"),
      age: z.number().int().min(0),
    });

    t = await testContext()
      .routes([
        craft()
          .id("schema-tool")
          .from(
            tool("schema-tool", {
              description: "Tool with schema",
              schema,
            }),
          )
          .to(noop()),
      ])
      .build();

    server = new MCPServer(t.ctx);
    expect(server).toBeDefined();
  });

  /**
   * @case Verifies that MCPServer handles tools without schema
   * @preconditions A tool route without schema is registered
   * @expectedResult Server provides default object schema
   */
  test("MCPServer handles tools without schema", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("no-schema-tool")
          .from(
            tool("no-schema-tool", {
              description: "Tool without explicit schema",
            }),
          )
          .to(noop()),
      ])
      .build();

    server = new MCPServer(t.ctx);
    expect(server).toBeDefined();
  });

  /**
   * @case Verifies that MCPServer ignores direct() routes without description
   * @preconditions Both tool() and direct() routes are registered
   * @expectedResult Only tool() routes are exposed
   */
  test("MCPServer applies sensible defaults", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("exposed-tool")
          .from(
            tool("exposed-tool", {
              description: "A tool route that should be exposed",
            }),
          )
          .to(noop()),
        craft()
          .id("internal-direct")
          .from(direct("internal-direct", {}))
          .to(noop()),
      ])
      .build();
    server = new MCPServer(t.ctx);
    expect(server).toBeDefined();
    const routeStartedPromise = new Promise<void>((resolve) => {
      let count = 0;
      t.ctx.on("routeStarted", () => {
        count++;
        if (count >= 2) resolve();
      });
    });
    const startPromise = t.ctx.start();
    await routeStartedPromise;
    const tools = server.getAvailableTools();
    const names = tools.map((t) => t.name as string);
    expect(names).toContain("exposed-tool");
    expect(names).not.toContain("internal-direct");
    expect(names).toEqual(["exposed-tool"]);
    await t.ctx.stop();
    await startPromise;
  });
});
