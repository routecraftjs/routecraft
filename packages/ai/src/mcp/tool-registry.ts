import type { McpTool, McpToolRegistryEntry } from "./types.ts";
import { deriveTagsFromAnnotations } from "./annotation-tags.ts";

/**
 * Central registry of MCP tools discovered from remote MCP servers.
 * Stored in context store under MCP_TOOL_REGISTRY for agent adapter discovery.
 *
 * Populated automatically by mcpPlugin for these sources:
 * - stdio clients: long-lived subprocess MCP servers
 * - HTTP clients: remote HTTP MCP servers (tools refreshed periodically)
 *
 * Local `mcp()` routes defined in the same context are NOT auto-populated here;
 * they live in the parallel `MCP_LOCAL_TOOL_REGISTRY` store and are read from
 * there by the MCP server when responding to `tools/list`. The "local" transport
 * label remains a valid value for callers that want to manually register tools
 * with that provenance.
 */
export class McpToolRegistry {
  /** Nested Map: source -> toolName -> McpToolRegistryEntry */
  private tools = new Map<string, Map<string, McpToolRegistryEntry>>();

  /** Monotonic change counter; bumped on every observable mutation. */
  private changeVersion = 0;

  /** Per-source fingerprint of the last stored tool list. */
  private fingerprints = new Map<string, string>();

  /** Keys already reported by a consumer for {@link reportedVersion}. */
  private reported = new Set<string>();

  /** Registry version {@link reported} was accumulated against. */
  private reportedVersion = -1;

  /**
   * Monotonically increasing version, bumped whenever a source's tools
   * actually change (a periodic re-listing that returns the same tools does
   * not bump it). Lets consumers (e.g. the MCP server's proxy resolution)
   * memoize derived state and recompute only when the registry changed,
   * instead of on every read or refresh tick.
   */
  get version(): number {
    return this.changeVersion;
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
    tools: McpTool[],
  ): void {
    const sourceMap = new Map<string, McpToolRegistryEntry>();

    for (const tool of tools) {
      const entry: McpToolRegistryEntry = {
        name: tool.name,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        source,
        transport,
      };
      if (tool.title !== undefined) {
        entry.title = tool.title;
      }
      if (tool.description !== undefined) {
        entry.description = tool.description;
      }
      if (tool.outputSchema !== undefined) {
        entry.outputSchema = tool.outputSchema as Record<string, unknown>;
      }
      if (tool.icons !== undefined) {
        entry.icons = tool.icons;
      }
      if (tool.annotations !== undefined) {
        entry.annotations = tool.annotations;
      }
      const derivedTags = deriveTagsFromAnnotations(tool.annotations);
      if (derivedTags.length > 0) {
        entry.tags = derivedTags;
      }
      sourceMap.set(tool.name, entry);
    }

    this.tools.set(source, sourceMap);

    // Only bump the change version when the source's tools actually
    // differ from what was stored, so periodic HTTP re-listings with an
    // unchanged tool set do not invalidate memoized consumers.
    const fingerprint = JSON.stringify([transport, tools]);
    if (this.fingerprints.get(source) !== fingerprint) {
      this.fingerprints.set(source, fingerprint);
      this.changeVersion++;
    }
  }

  /**
   * Claim the right to report `key` once for the registry's current
   * {@link version}. Returns true the first time a key is claimed and
   * false for every later claim, until the registry actually changes.
   *
   * For consumers that diagnose a persistent property of a registered
   * tool rather than an event of the call they are serving. The agent
   * tool resolver is the motivating case: it runs per dispatch, so a
   * remote tool whose name cannot be used as a provider tool name would
   * otherwise log the same warning on every dispatch of every agent
   * bound to that server, forever.
   *
   * Scoped to the version rather than to the registry's lifetime so a
   * condition that survives a refresh is re-reported rather than
   * silenced by its first occurrence. A periodic re-listing that
   * returns an unchanged tool set does not bump the version, so it does
   * not re-open the reports either.
   *
   * @param key - Stable identity of the condition being reported
   * @returns Whether the caller should report it
   * @internal
   */
  shouldReport(key: string): boolean {
    if (this.reportedVersion !== this.changeVersion) {
      this.reportedVersion = this.changeVersion;
      this.reported.clear();
    }
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    return true;
  }

  /**
   * Remove all tools for a source (when a client is permanently stopped).
   *
   * @param source - Source identifier whose tools should be removed
   */
  removeSource(source: string): void {
    if (this.tools.delete(source)) {
      this.fingerprints.delete(source);
      this.changeVersion++;
    }
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
