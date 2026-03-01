import type { Exchange } from "@routecraft/routecraft";
import { getExchangeContext } from "@routecraft/routecraft";
import type { Destination } from "@routecraft/routecraft";
import type {
  McpArgsExtractor,
  McpClientHttpConfig,
  McpClientOptions,
} from "./types.ts";
import { ADAPTER_MCP_CLIENT_SERVERS } from "./types.ts";

/** Ensure inline url is HTTP(S) only; stdio is not supported in routes. */
function assertHttpUrl(url: string): void {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error(
      `MCP client: url must be HTTP or HTTPS. Stdio is not supported in routes; register stdio clients via mcpPlugin({ clients: { name: { command, args } } }). Got: "${url.slice(0, 50)}${url.length > 50 ? "..." : ""}"`,
    );
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
    const servers = context.getStore(
      ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, McpClientHttpConfig | string> | undefined;
    const config = servers?.get(options.serverId);
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
 * Default args extractor: use exchange body as tool arguments.
 * If body is a non-null object, use it as the args; otherwise use { input: body }.
 */
export const defaultArgs: McpArgsExtractor = (exchange) =>
  typeof exchange.body === "object" && exchange.body !== null
    ? (exchange.body as Record<string, unknown>)
    : { input: exchange.body };

/**
 * Internal client: calls a remote MCP server's tool.
 * Exported only for use by McpAdapter; not re-exported from package.
 */
export class McpClient implements Destination<unknown, unknown> {
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
    let clientModule: {
      Client: new (
        info: { name: string; version: string },
        options?: { capabilities?: Record<string, unknown> },
      ) => unknown;
    };
    let transportModule: {
      StreamableHTTPClientTransport: new (
        url: URL,
        options?: { sessionId?: string },
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
