import type { Exchange } from "@routecraft/routecraft";
import { getExchangeContext } from "@routecraft/routecraft";
import type { Destination } from "@routecraft/routecraft";
import { BRAND } from "../brand.ts";
import type {
  McpArgsExtractor,
  McpClientHttpConfig,
  McpClientOptions,
} from "./types.ts";

const ADAPTER_MCP_CLIENT_SERVERS = "routecraft.mcp.client.servers" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_MCP_CLIENT_SERVERS]: Map<string, McpClientHttpConfig | string>;
  }
}

/**
 * Resolves the URL for the MCP server from options or context (serverId).
 * Store holds McpClientHttpConfig (with url); backward-compat: value may be string.
 */
function resolveUrl(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): string {
  if (options.url) return options.url;
  if (options.serverId && !context) {
    throw new Error(
      `MCP client: serverId "${options.serverId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so store "${ADAPTER_MCP_CLIENT_SERVERS}" can be read.`,
    );
  }
  if (options.serverId && context) {
    const servers = context.getStore(
      ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, McpClientHttpConfig | string> | undefined;
    const config = servers?.get(options.serverId);
    if (!config) {
      throw new Error(
        `MCP client: serverId "${options.serverId}" not found in context store. Register it with context store key "${ADAPTER_MCP_CLIENT_SERVERS}".`,
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
 * Default args extractor: use exchange body as tool arguments.
 * If body is a non-null object, use it as the args; otherwise use { input: body }.
 */
export const defaultArgs: McpArgsExtractor = (exchange) =>
  typeof exchange.body === "object" && exchange.body !== null
    ? (exchange.body as Record<string, unknown>)
    : { input: exchange.body };

/**
 * McpClientAdapter calls a remote MCP server's tool and returns the result as the exchange body.
 * Use .to(mcp({ url, tool })) or .to(mcp({ serverId, tool, args })).
 */
export class McpClientAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.mcp.client";

  constructor(private readonly options: McpClientOptions) {
    (this as unknown as Record<symbol, boolean>)[BRAND.McpClientAdapter] = true;
  }

  async send(exchange: Exchange<unknown>): Promise<unknown> {
    const context = getExchangeContext(exchange);
    const url = resolveUrl(this.options, context);
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

    const result = await this.callRemoteTool(url, toolName, args);
    return result;
  }

  private async callRemoteTool(
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const clientModule =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const Client = clientModule.Client;
    const transportModule =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const StreamableHTTPClientTransport =
      transportModule.StreamableHTTPClientTransport as new (
        url: URL,
        options?: { sessionId?: string },
      ) => unknown;

    const url = new URL(serverUrl);
    const transport = new StreamableHTTPClientTransport(url);
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

      const content = response?.content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (first && typeof first === "object" && "text" in first)
          return first.text;
        if (first && typeof first === "object" && "data" in first)
          return (first as { data?: string }).data;
      }
      return response;
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

export { ADAPTER_MCP_CLIENT_SERVERS };
