import { beforeEach, describe, expect, test } from "bun:test";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";

describe("McpToolRegistry", () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
  });

  /**
   * @case setToolsForSource + getTools returns all tools
   * @preconditions Two sources with tools added
   * @expectedResult getTools() returns all tools from both sources
   */
  test("setToolsForSource + getTools returns all tools", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "tool1", description: "Tool 1", inputSchema: { type: "object" } },
    ]);
    registry.setToolsForSource("server-b", "http", [
      { name: "tool2", description: "Tool 2", inputSchema: { type: "object" } },
    ]);

    const tools = registry.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["tool1", "tool2"]),
    );
  });

  /**
   * @case getToolsByServer filters by source
   * @preconditions Two sources with tools added
   * @expectedResult getToolsByServer returns only tools from the specified source
   */
  test("getToolsByServer filters by source", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "tool1", inputSchema: { type: "object" } },
      { name: "tool2", inputSchema: { type: "object" } },
    ]);
    registry.setToolsForSource("server-b", "http", [
      { name: "tool3", inputSchema: { type: "object" } },
    ]);

    const aTools = registry.getToolsByServer("server-a");
    expect(aTools).toHaveLength(2);
    expect(aTools.every((t) => t.source === "server-a")).toBe(true);

    const bTools = registry.getToolsByServer("server-b");
    expect(bTools).toHaveLength(1);
    expect(bTools[0].name).toBe("tool3");
  });

  /**
   * @case getTool finds by name (first match)
   * @preconditions Tool added to registry
   * @expectedResult getTool returns the tool entry
   */
  test("getTool finds by name", () => {
    registry.setToolsForSource("server-a", "stdio", [
      {
        name: "search",
        description: "Search things",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);

    const tool = registry.getTool("search");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("search");
    expect(tool!.description).toBe("Search things");
    expect(tool!.source).toBe("server-a");
    expect(tool!.transport).toBe("stdio");
  });

  /**
   * @case getTool returns undefined for unknown tool
   * @preconditions Empty registry
   * @expectedResult getTool returns undefined
   */
  test("getTool returns undefined for unknown tool", () => {
    expect(registry.getTool("nonexistent")).toBeUndefined();
  });

  /**
   * @case getToolBySource finds by source and name
   * @preconditions Tool added to a specific source
   * @expectedResult getToolBySource returns the tool entry
   */
  test("getToolBySource finds by source and name", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "tool1", inputSchema: { type: "object" } },
    ]);

    expect(registry.getToolBySource("server-a", "tool1")).toBeDefined();
    expect(registry.getToolBySource("server-b", "tool1")).toBeUndefined();
    expect(registry.getToolBySource("server-a", "tool2")).toBeUndefined();
  });

  /**
   * @case setToolsForSource replaces previous entries for same source
   * @preconditions Source set twice with different tools
   * @expectedResult Only second set of tools remains
   */
  test("setToolsForSource replaces previous entries for same source", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "old-tool", inputSchema: { type: "object" } },
    ]);
    registry.setToolsForSource("server-a", "stdio", [
      { name: "new-tool", inputSchema: { type: "object" } },
    ]);

    const tools = registry.getToolsByServer("server-a");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("new-tool");
    expect(registry.getTool("old-tool")).toBeUndefined();
  });

  /**
   * @case removeSource clears tools for source
   * @preconditions Source with tools added, then removed
   * @expectedResult No tools remain for that source
   */
  test("removeSource clears tools for source", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "tool1", inputSchema: { type: "object" } },
    ]);
    registry.setToolsForSource("server-b", "http", [
      { name: "tool2", inputSchema: { type: "object" } },
    ]);

    registry.removeSource("server-a");

    expect(registry.getToolsByServer("server-a")).toHaveLength(0);
    expect(registry.getToolsByServer("server-b")).toHaveLength(1);
    expect(registry.getTools()).toHaveLength(1);
  });

  /**
   * @case Multiple sources with same tool name coexist
   * @preconditions Two sources both have a tool named "search"
   * @expectedResult Both tools accessible via getToolBySource, getTool returns first
   */
  test("multiple sources with same tool name coexist", () => {
    registry.setToolsForSource("server-a", "stdio", [
      {
        name: "search",
        description: "A search",
        inputSchema: { type: "object" },
      },
    ]);
    registry.setToolsForSource("server-b", "http", [
      {
        name: "search",
        description: "B search",
        inputSchema: { type: "object" },
      },
    ]);

    expect(registry.getTools()).toHaveLength(2);
    expect(registry.getToolBySource("server-a", "search")?.description).toBe(
      "A search",
    );
    expect(registry.getToolBySource("server-b", "search")?.description).toBe(
      "B search",
    );

    // getTool returns first match (insertion order)
    const first = registry.getTool("search");
    expect(first).toBeDefined();
    expect(first!.source).toBe("server-a");
  });

  /**
   * @case setToolsForSource with empty array removes all tools for source
   * @preconditions Source with tools, then set with empty array
   * @expectedResult No tools remain for that source
   */
  test("setToolsForSource with empty array removes all tools for source", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "tool1", inputSchema: { type: "object" } },
    ]);
    registry.setToolsForSource("server-a", "stdio", []);

    expect(registry.getToolsByServer("server-a")).toHaveLength(0);
  });

  /**
   * @case Local tools use transport "local"
   * @preconditions Local tools added with transport "local"
   * @expectedResult Tools have transport "local"
   */
  test("local tools use transport local", () => {
    registry.setToolsForSource("local", "local", [
      {
        name: "my-route",
        description: "A local route",
        inputSchema: { type: "object" },
      },
    ]);

    const tool = registry.getTool("my-route");
    expect(tool?.transport).toBe("local");
    expect(tool?.source).toBe("local");
  });

  /**
   * @case Annotations are stored and retrievable from registry entries
   * @preconditions Tool added with annotations
   * @expectedResult Registry entry contains annotations
   */
  test("stores and returns annotations", () => {
    registry.setToolsForSource("server-a", "stdio", [
      {
        name: "read-tool",
        description: "Read-only tool",
        inputSchema: { type: "object" },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
    ]);

    const tool = registry.getTool("read-tool");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  /**
   * @case Tools without annotations have no annotations property
   * @preconditions Tool added without annotations
   * @expectedResult Registry entry has no annotations
   */
  test("omits annotations when not provided", () => {
    registry.setToolsForSource("server-a", "stdio", [
      { name: "plain", inputSchema: { type: "object" } },
    ]);

    const tool = registry.getTool("plain");
    expect(tool?.annotations).toBeUndefined();
  });

  /**
   * @case Annotations are derived into `tags` so the `{ tagged }` selector picks up MCP tools
   * @preconditions Four tools each carrying a different annotation hint
   * @expectedResult Each entry's `tags` matches the documented mapping (readOnlyHint -> "read-only", destructiveHint -> "destructive", idempotentHint -> "idempotent", openWorldHint -> "open-world")
   */
  test("derives tags from annotations at registration time", () => {
    registry.setToolsForSource("server-a", "http", [
      {
        name: "read",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "write",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      },
      {
        name: "idem",
        inputSchema: { type: "object" },
        annotations: { idempotentHint: true },
      },
      {
        name: "world",
        inputSchema: { type: "object" },
        annotations: { openWorldHint: true },
      },
    ]);
    expect(registry.getTool("read")?.tags).toEqual(["read-only"]);
    expect(registry.getTool("write")?.tags).toEqual(["destructive"]);
    expect(registry.getTool("idem")?.tags).toEqual(["idempotent"]);
    expect(registry.getTool("world")?.tags).toEqual(["open-world"]);
  });

  /**
   * @case Multiple annotation hints combine into multiple tags
   * @preconditions readOnlyHint and idempotentHint both true
   * @expectedResult tags include both "read-only" and "idempotent" in mapping order
   */
  test("combines multiple annotation hints into multiple tags", () => {
    registry.setToolsForSource("server-a", "http", [
      {
        name: "safe",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    ]);
    expect(registry.getTool("safe")?.tags).toEqual(["read-only", "idempotent"]);
  });

  /**
   * @case Tools without active hints carry no tags
   * @preconditions Tool with an annotations object whose hints are all false / undefined
   * @expectedResult tags field is omitted from the registry entry
   */
  test("omits tags field when no hints apply", () => {
    registry.setToolsForSource("server-a", "http", [
      { name: "plain", inputSchema: { type: "object" }, annotations: {} },
    ]);
    expect(registry.getTool("plain")?.tags).toBeUndefined();
  });
});
