import {
  isRoutecraftError,
  rcError,
  type CraftContext,
} from "@routecraft/routecraft";
import { connectMcpHttpClient } from "./sdk.ts";
import { extractContent } from "./extract-content.ts";
import {
  ADAPTER_MCP_CLIENT_SERVERS,
  MCP_STDIO_MANAGERS,
  type McpClientAuthOptions,
  type McpClientHttpConfig,
  type McpRawToolResult,
} from "./types.ts";

/**
 * Dispatch an MCP tool call against a server registered via
 * `mcpPlugin({ clients })` and extract the result content. Used by both
 * the `mcp(...)` destination adapter and the agent `tools([...])`
 * resolver. Thin wrapper over {@link dispatchMcpCallRaw} so the two
 * dispatch flavours (raw for the proxy, extracted here) can never drift.
 *
 * - For stdio clients (`MCP_STDIO_MANAGERS.get(serverId)`), delegates
 *   to the long-lived `StdioClientManager.callToolRaw`.
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
  return extractContent(
    await dispatchMcpCallRaw(ctx, serverId, toolName, args),
  );
}

/**
 * Dispatch an MCP tool call like {@link dispatchMcpCall} but return the raw
 * MCP `tools/call` result (content array, structuredContent, isError) without
 * content extraction. Used by the MCP server's proxy path so remote results
 * pass through to the calling client verbatim.
 *
 * Throws `RC5003` under the same conditions as {@link dispatchMcpCall}.
 *
 * @internal
 */
export async function dispatchMcpCallRaw(
  ctx: CraftContext,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpRawToolResult> {
  const stdioManagers = ctx.getStore(MCP_STDIO_MANAGERS);
  const manager = stdioManagers?.get(serverId);
  if (manager) {
    try {
      return await manager.callToolRaw(toolName, args);
    } catch (cause) {
      if (isRoutecraftError(cause)) throw cause;
      throw rcError("RC5003", cause, {
        message: `mcp dispatch: stdio call to "${serverId}:${toolName}" failed.`,
      });
    }
  }

  const http = resolveHttpConfig(ctx, serverId);
  return callRemoteToolRaw(http.url, toolName, args, http.auth);
}

/**
 * Resolve the HTTP config for a registered server id, throwing `RC5003` when
 * the server is unknown, is a string shorthand, is a stdio server whose
 * manager is absent, or has no url.
 */
function resolveHttpConfig(
  ctx: CraftContext,
  serverId: string,
): McpClientHttpConfig {
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
  return http;
}

/**
 * Open a one-shot MCP SDK client over Streamable HTTP, dispatch the
 * tool, then close. Used by `dispatchMcpCall` for the HTTP path and
 * by `McpEnricherAdapter` for inline-URL routes that bypass the
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
  return extractContent(
    await callRemoteToolRaw(serverUrl, toolName, args, auth),
  );
}

/**
 * Like {@link callRemoteTool} but returns the raw MCP `tools/call` result
 * without content extraction. Used by the MCP server's proxy path.
 *
 * @internal
 */
export async function callRemoteToolRaw(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  auth?: McpClientAuthOptions,
): Promise<McpRawToolResult> {
  let connection: Awaited<ReturnType<typeof connectMcpHttpClient>> | undefined;
  try {
    connection = await connectMcpHttpClient(new URL(serverUrl), auth);
    return (await connection.client.callTool({
      name: toolName,
      arguments: args,
    })) as McpRawToolResult;
  } catch (cause) {
    // Wrap SDK / transport / network errors as RC5003 with the original
    // attached as `cause`, matching the Error and Logging Policy
    // (`level 1`: throw rcError with the right framework code so the
    // dispatch boundary always surfaces an MCP-tagged error rather than
    // a bare TypeError or SDK-specific class). `RoutecraftError`s
    // thrown by called helpers pass through unchanged so caller-facing
    // error codes are preserved.
    if (isRoutecraftError(cause)) throw cause;
    throw rcError("RC5003", cause, {
      message: `mcp dispatch: failed to call tool "${toolName}" at "${serverUrl}".`,
    });
  } finally {
    // `connection` stays undefined when URL parsing or the handshake threw;
    // a failed handshake already closed its own transport. Cleanup errors are
    // swallowed so the original failure propagates.
    try {
      await connection?.client.close();
    } catch {
      // Ignore cleanup errors so original error propagates
    }
    try {
      await connection?.transport.close();
    } catch {
      // Ignore cleanup errors so original error propagates
    }
  }
}
