import type { CraftContext } from "@routecraft/routecraft";
import { MCP_TOOL_REGISTRY } from "./types.ts";
import type {
  McpProxyToolConfig,
  McpTool,
  McpToolRegistryEntry,
} from "./types.ts";

/**
 * Validation pattern for exposed MCP tool names. Mirrors the pattern the
 * `mcp()` source adapter applies to route ids so proxied and route-backed
 * tools obey the same naming contract.
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Parsed `mcpPlugin({ proxy })` ref. `toolName` is `"*"` for wildcards. */
export interface McpProxyRef {
  serverId: string;
  toolName: string;
}

/**
 * Parse a proxy ref string: `"server:tool"`, `"server:*"`, or bare
 * `"server"` (equivalent to `"server:*"`, matching the agent's
 * whole-server `MCP(server)` form).
 *
 * Throws `TypeError` on malformed refs so both option validation and
 * runtime resolution fail with the same message.
 *
 * @internal
 */
export function parseProxyRef(ref: string): McpProxyRef {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new TypeError(
      'mcpPlugin: proxy ref must be a non-empty string like "server:tool", "server:*", or "server"',
    );
  }
  const idx = ref.indexOf(":");
  if (idx === -1) {
    return { serverId: ref, toolName: "*" };
  }
  const serverId = ref.slice(0, idx);
  const toolName = ref.slice(idx + 1);
  if (serverId === "" || toolName === "" || toolName.includes(":")) {
    throw new TypeError(
      `mcpPlugin: proxy ref "${ref}" is malformed. Use "server:tool", "server:*", or "server".`,
    );
  }
  return { serverId, toolName };
}

/**
 * Normalize a `proxy` option array to config-object form (`string` entries
 * become `{ ref }`).
 *
 * @internal
 */
export function normalizeProxyEntries(
  proxy: Array<string | McpProxyToolConfig>,
): McpProxyToolConfig[] {
  return proxy.map((entry) =>
    typeof entry === "string" ? { ref: entry } : entry,
  );
}

/**
 * A client tool selected for proxying, resolved against the live tool
 * registry. Carries everything `tools/list` and `tools/call` need.
 */
export interface McpProxiedTool {
  /** Name this server exposes the tool under (override or remote name). */
  exposedName: string;
  /** Registered client the tool dispatches to. */
  serverId: string;
  /** Tool name on the remote server (dispatch target). */
  toolName: string;
  /** The registry entry the tool resolved from. */
  entry: McpToolRegistryEntry;
  /** Per-entry config overrides (description, annotations). */
  config: McpProxyToolConfig;
}

/**
 * Resolve the `proxy` selection against the current MCP tool registry.
 *
 * Resolution is dynamic: called on every `tools/list` / `tools/call` so
 * wildcard entries follow tool refresh and stdio restarts. Entries that do
 * not resolve (client not yet listed, tool gone after refresh) are skipped
 * via `warn` rather than thrown, because client availability is transient
 * by design (the plugin already tolerates a failed initial listing).
 *
 * Collisions between two proxy entries are first-wins in config order;
 * the loser is reported through `warn`. Collisions with local route tools
 * are the caller's concern (the server checks its local registry).
 *
 * @internal
 */
export function resolveProxiedTools(
  ctx: CraftContext,
  proxy: Array<string | McpProxyToolConfig>,
  warn: (key: string, message: string) => void,
): Map<string, McpProxiedTool> {
  const resolved = new Map<string, McpProxiedTool>();
  const registry = ctx.getStore(MCP_TOOL_REGISTRY);
  if (!registry) {
    warn(
      "proxy:no-registry",
      "mcpPlugin proxy: no MCP tool registry present; proxied tools are unavailable.",
    );
    return resolved;
  }

  const add = (
    entry: McpToolRegistryEntry,
    config: McpProxyToolConfig,
  ): void => {
    const exposedName = config.name ?? entry.name;
    const existing = resolved.get(exposedName);
    if (existing) {
      warn(
        `proxy:conflict:${exposedName}`,
        `mcpPlugin proxy: tool name "${exposedName}" from "${config.ref}" collides with "${existing.serverId}:${existing.toolName}"; first entry wins. Use a name override to expose both.`,
      );
      return;
    }
    resolved.set(exposedName, {
      exposedName,
      serverId: entry.source,
      toolName: entry.name,
      entry,
      config,
    });
  };

  for (const config of normalizeProxyEntries(proxy)) {
    const { serverId, toolName } = parseProxyRef(config.ref);
    const clientTools = registry.getToolsByServer(serverId);
    if (clientTools.length === 0) {
      warn(
        `proxy:unresolved:${serverId}`,
        `mcpPlugin proxy: client "${serverId}" has no registered tools (not yet listed, or listing failed); its proxy entries are skipped until tools appear.`,
      );
      continue;
    }
    if (toolName === "*") {
      for (const entry of clientTools) add(entry, config);
      continue;
    }
    const entry = clientTools.find((t) => t.name === toolName);
    if (!entry) {
      warn(
        `proxy:unresolved:${config.ref}`,
        `mcpPlugin proxy: tool "${toolName}" is not registered under client "${serverId}". Known tools: ${clientTools
          .map((t) => `"${t.name}"`)
          .sort()
          .join(", ")}.`,
      );
      continue;
    }
    add(entry, config);
  }

  return resolved;
}

/**
 * Convert a resolved proxied tool to the MCP `tools/list` wire shape.
 * Remote schema, title, description, annotations, and icons pass through;
 * per-entry `description` overrides replace and `annotations` overrides
 * merge over the remote values.
 *
 * @internal
 */
export function proxiedToolToMcpTool(proxied: McpProxiedTool): McpTool {
  const { entry, config } = proxied;
  const inputSchema =
    entry.inputSchema && typeof entry.inputSchema === "object"
      ? (entry.inputSchema as McpTool["inputSchema"])
      : ({ type: "object" } as McpTool["inputSchema"]);
  const tool: McpTool = {
    name: proxied.exposedName,
    inputSchema,
  };
  const description = config.description ?? entry.description;
  if (description !== undefined) {
    tool.description = description;
  }
  if (entry.title !== undefined) {
    tool.title = entry.title;
  }
  if (entry.outputSchema !== undefined) {
    tool.outputSchema = entry.outputSchema as NonNullable<
      McpTool["outputSchema"]
    >;
  }
  const annotations =
    entry.annotations || config.annotations
      ? { ...entry.annotations, ...config.annotations }
      : undefined;
  if (annotations !== undefined) {
    tool.annotations = annotations;
  }
  if (entry.icons !== undefined && entry.icons.length > 0) {
    tool.icons = entry.icons;
  }
  return tool;
}
