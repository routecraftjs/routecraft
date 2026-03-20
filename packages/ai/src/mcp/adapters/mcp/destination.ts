import type { Exchange, Destination } from "@routecraft/routecraft";
import { getExchangeContext } from "@routecraft/routecraft";
import type {
  McpClientOptions,
  McpArgsExtractor,
  McpClientAuthOptions,
  McpClientHttpConfig,
} from "../../types.ts";
import { ADAPTER_MCP_CLIENT_SERVERS, MCP_STDIO_MANAGERS } from "../../types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";
import { extractContent } from "../../extract-content.ts";
import { buildAuthHeaders } from "../../build-auth-headers.ts";

/** Ensure inline url is HTTP(S) only. Stdio clients are resolved via MCP_STDIO_MANAGERS store. */
function assertHttpUrl(url: string): void {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error(
      `MCP client: url must be HTTP or HTTPS. Stdio is not supported in routes; register stdio clients via mcpPlugin({ clients: { name: { command, args } } }). Got: "${url.slice(0, 50)}${url.length > 50 ? "..." : ""}"`,
    );
  }
}

/**
 * Look up the registered server config from the context store.
 * Returns undefined when no context or no matching serverId.
 * Backward-compat: store value may be a plain string (url only).
 */
function resolveServerConfig(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): McpClientHttpConfig | string | undefined {
  if (!options.serverId || !context) return undefined;
  const servers = context.getStore(
    ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, McpClientHttpConfig | string> | undefined;
  return servers?.get(options.serverId);
}

/**
 * Resolves the URL for the MCP server from options or context (serverId).
 * Store holds McpClientHttpConfig (with url); backward-compat: value may be string.
 */
function resolveUrl(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): string {
  if (options.url) {
    assertHttpUrl(options.url);
    return options.url;
  }
  if (options.serverId && !context) {
    throw new Error(
      `MCP client: serverId "${options.serverId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so store "${String(ADAPTER_MCP_CLIENT_SERVERS)}" can be read.`,
    );
  }
  if (options.serverId && context) {
    const config = resolveServerConfig(options, context);
    if (!config) {
      throw new Error(
        `MCP client: serverId "${options.serverId}" not found in context store. Register it with context store key "${String(ADAPTER_MCP_CLIENT_SERVERS)}".`,
      );
    }
    if (typeof config === "string") return config;
    return config.url;
  }
  throw new Error(
    "MCP client: either url or serverId must be provided in McpClientOptions.",
  );
}

/**
 * Resolves auth for the MCP client connection.
 * Prefers auth from McpClientOptions (inline url case); falls back to auth from
 * the registered server config (serverId case).
 */
function resolveAuth(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): McpClientAuthOptions | undefined {
  if (options.auth) return options.auth;
  const config = resolveServerConfig(options, context);
  if (config && typeof config === "object" && "auth" in config) {
    return config.auth;
  }
  return undefined;
}

/**
 * Default args extractor: use exchange body as tool arguments.
 * If body is a non-null object, use it as the args; otherwise use { input: body }.
 */
export const defaultArgs: McpArgsExtractor = (exchange) =>
  typeof exchange.body === "object" && exchange.body !== null
    ? (exchange.body as Record<string, unknown>)
    : { input: exchange.body };

/**
 * McpDestinationAdapter implements the Destination interface for the MCP adapter.
 *
 * This adapter is used when mcp() is called with client options:
 * - `mcp({ url, tool })` - Direct HTTP URL
 * - `mcp({ serverId, tool })` - Server registered via mcpPlugin
 * - `mcp('server:tool')` - Shorthand for serverId:tool
 *
 * It makes HTTP calls to remote MCP servers using the MCP SDK.
 */
export class McpDestinationAdapter implements Destination<unknown, unknown> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  constructor(private readonly options: McpClientOptions) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;

    // Validate client options
    if (!options.url && !options.serverId) {
      throw new Error(
        "MCP client: either url or serverId must be provided in McpClientOptions.",
      );
    }

    if (options.url && options.serverId) {
      throw new Error(
        "MCP client: cannot provide both url and serverId. Use either url for direct HTTP or serverId for registered servers.",
      );
    }
  }

  async send(exchange: Exchange<unknown>): Promise<unknown> {
    const context = getExchangeContext(exchange);
    const toolName =
      this.options.tool ??
      (typeof exchange.body === "object" &&
      exchange.body !== null &&
      "tool" in exchange.body &&
      typeof (exchange.body as { tool: string }).tool === "string"
        ? (exchange.body as { tool: string }).tool
        : undefined);
    if (!toolName) {
      throw new Error(
        "MCP client: tool name required. Set options.tool or exchange.body.tool.",
      );
    }
    const argsExtractor = this.options.args ?? defaultArgs;
    const args = argsExtractor(exchange);

    // Check for stdio manager first (registered via mcpPlugin)
    if (this.options.serverId && context) {
      const stdioManagers = context.getStore(
        MCP_STDIO_MANAGERS as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as
        | Map<
            string,
            {
              callTool(
                name: string,
                args: Record<string, unknown>,
              ): Promise<unknown>;
            }
          >
        | undefined;
      const manager = stdioManagers?.get(this.options.serverId);
      if (manager) {
        const result = await manager.callTool(toolName, args);
        if (result && typeof result === "object") {
          (result as Record<string, unknown>)["metadata"] = {
            toolName,
            transport: "stdio",
            serverId: this.options.serverId,
          };
        }
        return result;
      }

      // Guard: if the registered config is stdio-type but the manager is missing,
      // throw a clear error instead of falling through to HTTP (which would fail
      // confusingly since stdio configs have no url property).
      const servers = context.getStore(
        ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
      ) as Map<string, unknown> | undefined;
      const serverConfig = servers?.get(this.options.serverId);
      if (
        serverConfig &&
        typeof serverConfig === "object" &&
        "transport" in serverConfig &&
        (serverConfig as { transport: string }).transport === "stdio"
      ) {
        throw new Error(
          `MCP client: stdio server "${this.options.serverId}" is not running. Ensure mcpPlugin is applied and the stdio client started successfully.`,
        );
      }
    }

    // Fall through to HTTP
    const url = resolveUrl(this.options, context);
    const auth = resolveAuth(this.options, context);
    const result = await this.callRemoteTool(url, toolName, args, auth);

    // Attach metadata to result for getMetadata() to read (eliminates race condition)
    if (result && typeof result === "object") {
      (result as Record<string, unknown>)["metadata"] = {
        toolName,
        url,
        transport: "http",
        ...(this.options.serverId ? { serverId: this.options.serverId } : {}),
      };
    }

    return result;
  }

  /**
   * Extract metadata from MCP adapter execution.
   * Reads metadata from the result object to avoid race conditions with concurrent exchanges.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    if (result && typeof result === "object" && "metadata" in result) {
      return (result as { metadata: Record<string, unknown> }).metadata;
    }
    return {
      toolName: "unknown",
      transport: "unknown",
    };
  }

  private async callRemoteTool(
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
    auth?: McpClientAuthOptions,
  ): Promise<unknown> {
    let clientModule: {
      Client: new (
        info: { name: string; version: string },
        options?: { capabilities?: Record<string, unknown> },
      ) => unknown;
    };
    let transportModule: {
      StreamableHTTPClientTransport: new (
        url: URL,
        options?: {
          sessionId?: string;
          requestInit?: { headers?: Record<string, string> };
        },
      ) => unknown;
    };
    try {
      clientModule = await import("@modelcontextprotocol/sdk/client/index.js");
      transportModule =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    } catch {
      throw new Error(
        'MCP client requires "@modelcontextprotocol/sdk". Install it with: pnpm add @modelcontextprotocol/sdk',
      );
    }
    const Client = clientModule.Client;
    const StreamableHTTPClientTransport =
      transportModule.StreamableHTTPClientTransport;

    const url = new URL(serverUrl);
    const headers = await buildAuthHeaders(auth);
    const transportOptions = headers ? { requestInit: { headers } } : undefined;
    const transport = new StreamableHTTPClientTransport(url, transportOptions);
    const clientInfo = { name: "routecraft-mcp-client", version: "1.0.0" };
    const client = new (Client as new (
      info: { name: string; version: string },
      options?: { capabilities?: Record<string, unknown> },
    ) => InstanceType<typeof clientModule.Client>)(clientInfo, {
      capabilities: {},
    });
    try {
      const connect = (
        client as unknown as { connect(transport: unknown): Promise<void> }
      ).connect;
      await connect.call(client, transport);

      const callTool = (
        client as unknown as {
          callTool(params: {
            name: string;
            arguments?: Record<string, unknown>;
          }): Promise<{ content?: Array<{ type: string; text?: string }> }>;
        }
      ).callTool;
      const response = await callTool.call(client, {
        name: toolName,
        arguments: args,
      });

      return extractContent(response);
    } finally {
      const clientCleanup = client as unknown as {
        close?: () => void | Promise<void>;
        disconnect?: () => void | Promise<void>;
      };
      const closeOrDisconnect = clientCleanup.close ?? clientCleanup.disconnect;
      if (typeof closeOrDisconnect === "function") {
        try {
          await Promise.resolve(closeOrDisconnect.call(client));
        } catch {
          // Ignore cleanup errors so original error propagates
        }
      }
      const transportCleanup = transport as unknown as {
        close?: () => void | Promise<void>;
        destroy?: () => void;
      };
      const closeOrDestroy = transportCleanup.close ?? transportCleanup.destroy;
      if (typeof closeOrDestroy === "function") {
        try {
          await Promise.resolve(closeOrDestroy.call(transport));
        } catch {
          // Ignore cleanup errors so original error propagates
        }
      }
    }
  }
}
