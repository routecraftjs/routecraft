import {
  loadOptionalPeer,
  rcError,
  type CraftContext,
} from "@routecraft/routecraft";
import { buildAuthHeaders } from "./build-auth-headers.ts";
import { extractContent } from "./extract-content.ts";
import {
  ADAPTER_MCP_CLIENT_SERVERS,
  MCP_STDIO_MANAGERS,
  type McpClientAuthOptions,
  type McpClientHttpConfig,
} from "./types.ts";

/**
 * Dispatch an MCP tool call against a server registered via
 * `mcpPlugin({ clients })`. Used by both the `mcp(...)` destination
 * adapter and the agent `tools([...])` resolver so the same transport
 * logic backs both call sites.
 *
 * - For stdio clients (`MCP_STDIO_MANAGERS.get(serverId)`), delegates
 *   to the long-lived `StdioClientManager.callTool`.
 * - For HTTP clients (`ADAPTER_MCP_CLIENT_SERVERS.get(serverId).url`),
 *   opens a single MCP SDK client connection per call, dispatches,
 *   and closes. The agent path is per-tool-call so latency dominates
 *   over connection setup; if that becomes a problem the http
 *   client cache in `mcpPlugin` can be promoted to a context store
 *   in a follow-up.
 *
 * Throws `RC5003` when the server is not registered, when a stdio
 * server is registered but its manager is absent (mcpPlugin
 * teardown raced ahead, etc.), or when an HTTP call fails.
 *
 * @internal
 */
export async function dispatchMcpCall(
  ctx: CraftContext,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stdioManagers = ctx.getStore(MCP_STDIO_MANAGERS);
  const manager = stdioManagers?.get(serverId);
  if (manager) {
    return manager.callTool(toolName, args);
  }

  const servers = ctx.getStore(ADAPTER_MCP_CLIENT_SERVERS);
  const config = servers?.get(serverId);
  if (!config) {
    throw rcError("RC5003", undefined, {
      message: `mcp dispatch: server "${serverId}" is not registered. Register it via defineConfig.mcp / mcpPlugin({ clients }).`,
    });
  }
  if (typeof config !== "object" || config === null) {
    throw rcError("RC5003", undefined, {
      message: `mcp dispatch: server "${serverId}" config is a string shorthand and cannot be called directly. Use a full HTTP config with a url.`,
    });
  }
  if (
    "transport" in config &&
    (config as { transport: string }).transport === "stdio"
  ) {
    throw rcError("RC5003", undefined, {
      message: `mcp dispatch: stdio server "${serverId}" is registered but its client is not running. Ensure mcpPlugin started successfully.`,
    });
  }
  const http = config as McpClientHttpConfig;
  if (typeof http.url !== "string" || http.url.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `mcp dispatch: server "${serverId}" has no url. Cannot dispatch over HTTP.`,
    });
  }
  return callRemoteTool(http.url, toolName, args, http.auth);
}

/**
 * Open a one-shot MCP SDK client over Streamable HTTP, dispatch the
 * tool, then close. Used by `dispatchMcpCall` for the HTTP path and
 * by `McpDestinationAdapter` for inline-URL routes that bypass the
 * registry. Centralised here so transport setup, auth-header
 * building, and content extraction stay in one place.
 *
 * @internal
 */
export async function callRemoteTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  auth?: McpClientAuthOptions,
): Promise<unknown> {
  const clientModule = (await loadOptionalPeer(
    () => import("@modelcontextprotocol/sdk/client/index.js"),
    {
      adapterName: "mcp (http client)",
      packageName: "@modelcontextprotocol/sdk",
    },
  )) as unknown as {
    Client: new (
      info: { name: string; version: string },
      options?: { capabilities?: Record<string, unknown> },
    ) => unknown;
  };
  const transportModule = (await loadOptionalPeer(
    () => import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    {
      adapterName: "mcp (http client)",
      packageName: "@modelcontextprotocol/sdk",
    },
  )) as unknown as {
    StreamableHTTPClientTransport: new (
      url: URL,
      options?: {
        sessionId?: string;
        requestInit?: { headers?: Record<string, string> };
      },
    ) => unknown;
  };

  const url = new URL(serverUrl);
  const headers = await buildAuthHeaders(auth);
  const transportOptions = headers ? { requestInit: { headers } } : undefined;
  const transport = new transportModule.StreamableHTTPClientTransport(
    url,
    transportOptions,
  );
  const client = new clientModule.Client(
    { name: "routecraft-mcp-client", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await (client as unknown as { connect(t: unknown): Promise<void> }).connect(
      transport,
    );
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
