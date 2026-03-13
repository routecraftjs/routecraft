import type { McpToolRegistryEntry } from "./types.ts";

/**
 * Central registry of all MCP tools from all sources.
 * Stored in context store under MCP_TOOL_REGISTRY for agent adapter discovery.
 *
 * Sources:
 * - "local": mcp() routes from ADAPTER_DIRECT_REGISTRY (tools exposed by this context)
 * - stdio clients: long-lived subprocess MCP servers
 * - HTTP clients: remote HTTP MCP servers (tools refreshed periodically)
 */
export class McpToolRegistry {
  /** Map<"source:toolName", McpToolRegistryEntry> for uniqueness across sources. */
  private tools = new Map<string, McpToolRegistryEntry>();

  private key(source: string, name: string): string {
    return `${source}:${name}`;
  }

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
    // Remove existing tools for this source
    this.removeSource(source);

    // Add new tools
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
      this.tools.set(this.key(source, tool.name), entry);
    }
  }

  /**
   * Remove all tools for a source (when a client is permanently stopped).
   *
   * @param source - Source identifier whose tools should be removed
   */
  removeSource(source: string): void {
    const prefix = `${source}:`;
    for (const key of this.tools.keys()) {
      if (key.startsWith(prefix)) {
        this.tools.delete(key);
      }
    }
  }

  /**
   * Get all tools across all sources.
   *
   * @returns Array of every registered tool entry
   */
  getTools(): McpToolRegistryEntry[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools from a specific source/server.
   *
   * @param serverId - Source identifier to filter by
   * @returns Array of tool entries belonging to that source
   */
  getToolsByServer(serverId: string): McpToolRegistryEntry[] {
    return this.getTools().filter((t) => t.source === serverId);
  }

  /**
   * Get a specific tool by name. Returns first match if name exists in multiple sources.
   *
   * @param name - Tool name to search for
   * @returns The first matching entry, or undefined
   */
  getTool(name: string): McpToolRegistryEntry | undefined {
    for (const entry of this.tools.values()) {
      if (entry.name === name) return entry;
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
    return this.tools.get(this.key(source, name));
  }
}
