import type { Exchange } from "@routecraft/routecraft";
import { getExchangeContext } from "@routecraft/routecraft";
import type { Destination } from "@routecraft/routecraft";
import type { McpClientOptions } from "../dsl.ts";

const ADAPTER_MCP_CLIENT_SERVERS = "routecraft.mcp.client.servers" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_MCP_CLIENT_SERVERS]: Map<string, string>;
  }
}

/**
 * Resolves the URL for the MCP server from options or context (serverId).
 */
function resolveUrl(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): string {
  if (options.url) return options.url;
  if (options.serverId && context) {
    const servers = context.getStore(
      ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, string> | undefined;
    const url = servers?.get(options.serverId);
    if (url) return url;
    throw new Error(
      `MCP client: serverId "${options.serverId}" not found in context store. Register it with context store key "${ADAPTER_MCP_CLIENT_SERVERS}".`,
    );
  }
  throw new Error(
    "MCP client: either url or serverId must be provided in McpClientOptions.",
  );
}

/**
 * McpClientAdapter calls a remote MCP server's tool and returns the result as the exchange body.
 * Use with .to(mcp({ url, tool })) or .to(mcp({ serverId, tool })).
 */
export class McpClientAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.mcp.client";

  constructor(private readonly options: McpClientOptions) {}

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
    const args =
      typeof exchange.body === "object" && exchange.body !== null
        ? (exchange.body as Record<string, unknown>)
        : { input: exchange.body };

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
    const Client = clientModule.Client as new () => InstanceType<
      typeof clientModule.Client
    >;
    const transportModule =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const StreamableHTTPClientTransport =
      transportModule.StreamableHTTPClientTransport as new (
        url: URL,
        options?: { sessionId?: string },
      ) => unknown;

    const url = new URL(serverUrl);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client();
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
  }
}

export { ADAPTER_MCP_CLIENT_SERVERS };
