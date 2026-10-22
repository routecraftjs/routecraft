import { port, rcError } from "@routecraft/routecraft";
import { McpToolRegistry } from "./tool-registry.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpLocalToolEntry,
  McpProxyRegistration,
  McpStdioToolCaller,
} from "./types.ts";
import { proxyRegistrationKey } from "./proxy.ts";

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
  /**
   * The routes that proxy a client's tools (`.from(mcp({ proxy }))`), by
   * `server:tool` or `server:*`. The server resolves them against the
   * clients' live tool lists on every listing, and the agent tool resolver
   * sends an `MCP(server:tool)` reference through the covering route.
   * Written through {@link registerProxy} alone.
   */
  readonly proxies: ReadonlyMap<string, McpProxyRegistration>;
  /**
   * Bumped whenever {@link proxies} changes, so a consumer memoising the
   * exposed tools recomputes only when a registration came or went.
   */
  readonly proxiesVersion: number;
  /**
   * Register a route as the proxy of a client's tools. Returns the function
   * that withdraws it.
   *
   * @throws RC5003 when another route already proxies that tool, or that
   *   whole client
   */
  registerProxy(registration: McpProxyRegistration): () => void;
  /**
   * Run `listener` after every change to {@link local} or {@link proxies},
   * so a transport can tell its clients the advertised tools changed.
   * Returns the function that stops it.
   */
  onChange(listener: () => void): () => void;
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
  const proxies = new Map<string, McpProxyRegistration>();
  let proxiesVersion = 0;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    local,
    proxies,
    get proxiesVersion() {
      return proxiesVersion;
    },
    registerProxy(registration) {
      const key = proxyRegistrationKey(
        registration.serverId,
        registration.tool,
      );
      const existing = proxies.get(key);
      if (existing) {
        throw rcError("RC5003", undefined, {
          message:
            registration.tool === "*"
              ? `Route "${registration.routeId}" proxies every tool of client "${registration.serverId}", and so does route "${existing.routeId}"`
              : `Route "${registration.routeId}" proxies "${registration.serverId}:${registration.tool}", and so does route "${existing.routeId}"`,
          suggestion:
            "One route proxies a client's tools, and one route proxies a given tool with its own policy. Merge the two, or narrow one of them.",
        });
      }
      const registered: McpProxyRegistration = { ...registration };
      proxies.set(key, registered);
      proxiesVersion++;
      changed();
      return () => {
        if (proxies.get(key) === registered) {
          proxies.delete(key);
          proxiesVersion++;
          changed();
        }
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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
      changed();
      return () => {
        if (local.get(registered.endpoint) === registered) {
          local.delete(registered.endpoint);
          changed();
        }
      };
    },
    tools: seed.tools ?? new McpToolRegistry(),
    stdio: seed.stdio ?? new Map(),
    clients: seed.clients ?? new Map(),
  };
}
