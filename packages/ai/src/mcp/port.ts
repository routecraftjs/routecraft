import { port, rcError } from "@routecraft/routecraft";
import { McpToolRegistry } from "./tool-registry.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpLocalToolEntry,
  McpStdioToolCaller,
} from "./types.ts";

/** A configured MCP client, by the shape the application gave it. */
export type McpClientConfig =
  McpClientHttpConfig | McpClientStdioConfig | string;

/**
 * What the MCP plugin provides: the tools this application serves and the
 * clients it calls. The `mcp()` source registers its routes here, and the
 * agent tool selection, the `mcp()` client and the proxy read the clients'
 * tools from here.
 */
export interface McpService {
  /**
   * The `.from(mcp())` routes this application serves as tools, by tool
   * name, read by the MCP server for `tools/list` and `tools/call`. Written
   * through {@link registerLocal} alone.
   */
  readonly local: ReadonlyMap<string, McpLocalToolEntry>;
  /**
   * Serve a route as a tool, under its endpoint. Returns the function that
   * withdraws it.
   *
   * @throws RC5003 when another route already serves that endpoint
   */
  registerLocal(entry: McpLocalToolEntry): () => void;
  /** Every tool discovered from the configured clients. */
  readonly tools: McpToolRegistry;
  /** The managed stdio clients, by server id. */
  readonly stdio: ReadonlyMap<string, McpStdioToolCaller>;
  /** The configured clients, by server id. */
  readonly clients: ReadonlyMap<string, McpClientConfig>;
}

/** The MCP service the MCP plugin provides. */
export const MCP = port<McpService>("routecraft.ai.mcp@1");

/**
 * An MCP service over the given registries, empty where none is given: the
 * plugin fills it, and a test seeds it.
 *
 * @internal
 */
export function createMcpService(
  seed: {
    readonly tools?: McpToolRegistry;
    readonly stdio?: ReadonlyMap<string, McpStdioToolCaller>;
    readonly clients?: ReadonlyMap<string, McpClientConfig>;
    readonly local?: Iterable<McpLocalToolEntry>;
  } = {},
): McpService {
  const local = new Map<string, McpLocalToolEntry>();
  for (const entry of seed.local ?? []) local.set(entry.endpoint, entry);
  return {
    local,
    registerLocal(entry) {
      if (local.has(entry.endpoint)) {
        throw rcError("RC5003", undefined, {
          message: `Duplicate MCP tool endpoint "${entry.endpoint}": another .from(mcp(...)) route already registered this endpoint in the same context`,
          suggestion:
            "Each MCP tool endpoint must be unique within a context. Rename one of the mcp() routes to a different route id.",
        });
      }
      // The registration is a copy, so a caller editing its entry afterwards
      // cannot move the advertised name away from the key it is served
      // under, and re-registering one object twice yields two withdrawals
      // that each know only their own registration.
      const registered: McpLocalToolEntry = { ...entry };
      local.set(registered.endpoint, registered);
      return () => {
        if (local.get(registered.endpoint) === registered) {
          local.delete(registered.endpoint);
        }
      };
    },
    tools: seed.tools ?? new McpToolRegistry(),
    stdio: seed.stdio ?? new Map(),
    clients: seed.clients ?? new Map(),
  };
}
