import type { CraftContext } from "@routecraft/routecraft";
import { mergeAnnotations } from "./annotation-tags.ts";
import { TOOL_NAME_PATTERN_SOURCE } from "../tool-name.ts";
import { MCP_TOOL_NAME_PATTERN, MCP_TOOL_REGISTRY } from "./types.ts";
import type {
  McpProxyToolConfig,
  McpTool,
  McpToolRegistryEntry,
} from "./types.ts";

/** Parsed `mcpPlugin({ proxy })` ref. `toolName` is `"*"` for wildcards. */
export interface McpProxyRef {
  serverId: string;
  toolName: string;
}

/**
 * Parse a proxy ref string: `"server:tool"`, `"server:*"`, or bare
 * `"server"` (equivalent to `"server:*"`, matching the agent's
 * whole-server `MCP(server)` form). Colons beyond the first split stay in
 * the tool segment, matching the agent ref grammar (`parseMcpRef`), so a
 * remote tool named `ns:tool` is addressable as `"server:ns:tool"`. Such
 * a name needs a `name` override to be exposed (exposed names must match
 * {@link MCP_TOOL_NAME_PATTERN}).
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
  if (serverId === "" || toolName === "") {
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
 * The name a proxy entry exposes a remote tool under: the entry's `name`
 * override when set, otherwise the remote tool's own name. Shared by
 * static validation and runtime resolution so the two can never disagree.
 *
 * @internal
 */
export function exposedNameFor(
  config: McpProxyToolConfig,
  remoteToolName: string,
): string {
  return config.name ?? remoteToolName;
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
  /** Per-entry config overrides (description, annotations, guard). */
  config: McpProxyToolConfig;
}

/**
 * Resolve the `proxy` selection against the current MCP tool registry.
 *
 * Resolution follows the live registry (the server memoizes per registry
 * version, so this runs when the registry changes, not per request).
 * Entries that do not resolve (client not yet listed, tool gone after
 * refresh) are skipped via `warn` rather than thrown, because client
 * availability is transient by design (the plugin already tolerates a
 * failed initial listing).
 *
 * Collision policy:
 * - Two entries covering the SAME remote tool (an exact ref overlapping a
 *   wildcard) compose rather than collide: the exact entry's config
 *   (overrides, guard) wins regardless of config order, so a wildcard can
 *   never silently strip an explicitly configured guard.
 * - Two DIFFERENT remote tools mapping to one exposed name are first-wins
 *   in config order; the loser is reported through `warn`.
 * - Exposed names must match {@link MCP_TOOL_NAME_PATTERN}; non-conforming
 *   remote names are skipped via `warn` unless renamed. Collisions with
 *   local route tools are the caller's concern (the server checks its
 *   local registry).
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
    isExact: boolean,
  ): void => {
    const exposedName = exposedNameFor(config, entry.name);
    if (!MCP_TOOL_NAME_PATTERN.test(exposedName)) {
      warn(
        `proxy:invalid-name:${exposedName}`,
        `mcpPlugin proxy: remote tool "${entry.source}:${entry.name}" has a name that does not match ${TOOL_NAME_PATTERN_SOURCE} and is skipped. Proxy it with an exact ref and a "name" override to expose it.`,
      );
      return;
    }
    const existing = resolved.get(exposedName);
    if (existing) {
      const sameRemoteTool =
        existing.serverId === entry.source && existing.toolName === entry.name;
      if (!sameRemoteTool) {
        warn(
          `proxy:conflict:${exposedName}`,
          `mcpPlugin proxy: tool name "${exposedName}" from "${config.ref}" collides with "${existing.serverId}:${existing.toolName}"; first entry wins. Use a name override to expose both.`,
        );
        return;
      }
      // Exact and wildcard entries covering the same remote tool compose:
      // the exact entry's config is the operator's specific intent (its
      // guard and overrides must never be dropped by a broader wildcard),
      // so specific-wins regardless of config order.
      if (!isExact) return;
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
      for (const entry of clientTools) add(entry, config, false);
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
    add(entry, config, true);
  }

  return resolved;
}

/**
 * Convert a resolved proxied tool to the MCP `tools/list` wire shape.
 * Remote schema, title, description, and annotations pass through;
 * per-entry `description` overrides replace and `annotations` overrides
 * merge over the remote values. Icons are NOT set here: the server applies
 * the same inheritance rule it applies to local tools (`entry.icons ??`
 * server icons, omitted when empty), reading the tri-state (unset / [] /
 * set) off `proxied.entry.icons`.
 *
 * @internal
 */
export function proxiedToolToMcpTool(proxied: McpProxiedTool): McpTool {
  const { entry, config } = proxied;
  const tool: McpTool = {
    name: proxied.exposedName,
    inputSchema: entry.inputSchema as McpTool["inputSchema"],
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
  const annotations = mergeAnnotations(entry.annotations, config.annotations);
  if (annotations !== undefined) {
    tool.annotations = annotations;
  }
  return tool;
}
