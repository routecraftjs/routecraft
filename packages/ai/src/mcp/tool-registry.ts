import type { McpToolRegistryEntry } from "./types.ts";

/**
 * Central registry of all MCP tools from all sources.
 * Stored in context store under MCP_TOOL_REGISTRY for agent adapter discovery.
 *
 * Sources:
 * - "local": mcp() routes from ADAPTER_DIRECT_REGISTRY (tools exposed by this context)
 * - stdio clients: long-lived subprocess MCP servers
 * - HTTP clients: remote HTTP MCP servers (tools refreshed periodically)
 *
 * @experimental
 */
export class McpToolRegistry {
  /** Nested Map: source -> toolName -> McpToolRegistryEntry */
  private tools = new Map<string, Map<string, McpToolRegistryEntry>>();

  /**
   * Set all tools for a given source (replaces previous tools from that source).
   * Called on initial tool listing and on re-listing after restart/refresh.
   *
   * @param source - Identifier for the tool source (e.g. server ID or "local")
   * @param transport - How the tools are reached ("stdio", "http", or "local")
   * @param tools - Tool definitions to register for this source
   */
  setToolsForSource(
    source: string,
    transport: "stdio" | "http" | "local",
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>,
  ): void {
    const sourceMap = new Map<string, McpToolRegistryEntry>();

    for (const tool of tools) {
      const entry: McpToolRegistryEntry = {
        name: tool.name,
        inputSchema: tool.inputSchema,
        source,
        transport,
      };
      if (tool.description !== undefined) {
        entry.description = tool.description;
      }
      sourceMap.set(tool.name, entry);
    }

    this.tools.set(source, sourceMap);
  }

  /**
   * Remove all tools for a source (when a client is permanently stopped).
   *
   * @param source - Source identifier whose tools should be removed
   */
  removeSource(source: string): void {
    this.tools.delete(source);
  }

  /**
   * Get all tools across all sources.
   *
   * @returns Array of every registered tool entry
   */
  getTools(): McpToolRegistryEntry[] {
    const result: McpToolRegistryEntry[] = [];
    for (const sourceMap of this.tools.values()) {
      for (const entry of sourceMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Get tools from a specific source/server.
   *
   * @param serverId - Source identifier to filter by
   * @returns Array of tool entries belonging to that source
   */
  getToolsByServer(serverId: string): McpToolRegistryEntry[] {
    const sourceMap = this.tools.get(serverId);
    if (!sourceMap) return [];
    return Array.from(sourceMap.values());
  }

  /**
   * Get a specific tool by name. Returns first match if name exists in multiple sources.
   *
   * @param name - Tool name to search for
   * @returns The first matching entry, or undefined
   */
  getTool(name: string): McpToolRegistryEntry | undefined {
    for (const sourceMap of this.tools.values()) {
      const entry = sourceMap.get(name);
      if (entry) return entry;
    }
    return undefined;
  }

  /**
   * Get a specific tool by source and name.
   *
   * @param source - Source identifier
   * @param name - Tool name
   * @returns The matching entry, or undefined
   */
  getToolBySource(
    source: string,
    name: string,
  ): McpToolRegistryEntry | undefined {
    return this.tools.get(source)?.get(name);
  }
}
