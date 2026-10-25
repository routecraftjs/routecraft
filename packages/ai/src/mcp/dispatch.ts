import { clipText, isRoutecraftError, rcError } from "@routecraft/routecraft";
// Registers AI2003 before any dispatch can throw it.
import "../errors.ts";
import { connectMcpHttpClient } from "./sdk.ts";
import { extractContent } from "./extract-content.ts";
import type { McpService } from "./port.ts";
import {
  type McpClientAuthOptions,
  type McpClientHttpConfig,
  type McpRawToolResult,
} from "./types.ts";

/**
 * Dispatch an MCP tool call against a server registered via
 * `mcpPlugin({ clients })` and extract the result content. Used by both
 * the `mcp(...)` destination adapter and the agent `tools([...])`
 * resolver. Thin wrapper over {@link dispatchMcpCallRaw}, which fetches the
 * raw result that {@link toolResultBody} interprets.
 *
 * - For stdio clients (the service's `stdio` manager), delegates
 *   to the long-lived `StdioClientManager.callToolRaw`.
 * - For HTTP clients (the url of the service's `clients` entry),
 *   opens a single MCP SDK client connection per call, dispatches,
 *   and closes. The agent path is per-tool-call so latency dominates
 *   over connection setup; if that becomes a problem the http
 *   client cache in `mcpPlugin` can be promoted onto the service
 *   in a follow-up.
 *
 * Throws `RC5003` when the server is not registered, when a stdio
 * server is registered but its manager is absent (mcpPlugin
 * teardown raced ahead, etc.), or when an HTTP call fails.
 *
 * @internal
 */
export async function dispatchMcpCall(
  service: McpService | undefined,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return toolResultBody(
    await dispatchMcpCallRaw(service, serverId, toolName, args),
    `"${serverId}:${toolName}"`,
  );
}

/** How much of a remote error text reaches a message and a log line. */
const REMOTE_ERROR_TEXT_LIMIT = 500;

/** The bounded remote text of each AI2003, beside the error, never parsed out of its message. */
const REMOTE_TEXT = new WeakMap<Error, string>();

/** The route whose own proxied hop raised an AI2003, bound by the enricher. */
const RELAYED = new WeakMap<Error, string>();

/**
 * Bind an `AI2003` to the route whose hop to the proxied tool raised it.
 * The MCP server relays the remote's text to the caller of that route and
 * of no other: a caller who addressed the remote gets the remote's answer,
 * while the same code from a different hop or a nested route stays generic,
 * as the wire rules require. Anything but an `AI2003` is left alone.
 *
 * @internal
 */
export function relayRemoteError(error: unknown, routeId: string): void {
  if (error instanceof Error && REMOTE_TEXT.has(error)) {
    RELAYED.set(error, routeId);
  }
}

/**
 * The relay {@link relayRemoteError} bound, when the error is an `AI2003`
 * a proxying route's own hop raised.
 *
 * @internal
 */
export function relayedRemoteErrorOf(
  error: unknown,
): { routeId: string; text: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const routeId = RELAYED.get(error);
  const text = REMOTE_TEXT.get(error);
  return routeId === undefined || text === undefined
    ? undefined
    : { routeId, text };
}

/**
 * The body a remote `tools/call` result becomes for a route or an agent
 * tool: the structured content when the remote published one, otherwise
 * the extracted content (one text block as its string, several as the
 * array, none as the raw result).
 *
 * A result flagged `isError` is the remote reporting failure, so it throws
 * rather than arriving as content a route would process or a model would
 * summarise. The error names the tool and carries the remote's text,
 * bounded, because that text is the remote's answer to the caller.
 *
 * @throws AI2003 when the result is flagged `isError`
 * @internal
 */
export function toolResultBody(raw: McpRawToolResult, where: string): unknown {
  if (raw.isError === true) {
    const text = remoteErrorText(raw);
    const error = rcError("AI2003", undefined, {
      message: `Remote MCP tool ${where} reported an error${text === "" ? "" : `: ${text}`}`,
    });
    REMOTE_TEXT.set(error, text);
    throw error;
  }
  return raw.structuredContent !== undefined
    ? raw.structuredContent
    : extractContent(raw);
}

/** The text blocks of an error result, joined and bounded. */
function remoteErrorText(raw: McpRawToolResult): string {
  const text = (raw.content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((part) => part !== "")
    .join("\n")
    .trim();
  return clipText(text, REMOTE_ERROR_TEXT_LIMIT);
}

/**
 * Dispatch an MCP tool call like {@link dispatchMcpCall} but return the raw
 * MCP `tools/call` result (content array, structuredContent, isError) that
 * {@link toolResultBody} interprets.
 *
 * Throws `RC5003` under the same conditions as {@link dispatchMcpCall}.
 *
 * @internal
 */
export async function dispatchMcpCallRaw(
  service: McpService | undefined,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpRawToolResult> {
  const manager = service?.stdio.get(serverId);
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

  const http = resolveHttpConfig(service, serverId);
  return callRemoteToolRaw(http.url, toolName, args, http.auth);
}

/**
 * Resolve the HTTP config for a registered server id, throwing `RC5003` when
 * the server is unknown, is a string shorthand, is a stdio server whose
 * manager is absent, or has no url.
 */
function resolveHttpConfig(
  service: McpService | undefined,
  serverId: string,
): McpClientHttpConfig {
  const config = service?.clients.get(serverId);
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
  // The URL is configuration, not part of the answer: the message can
  // reach a caller, the route's own log carries the URL.
  return toolResultBody(
    await callRemoteToolRaw(serverUrl, toolName, args, auth),
    `"${toolName}"`,
  );
}

/**
 * Like {@link callRemoteTool} but returns the raw MCP `tools/call` result
 * that {@link toolResultBody} interprets.
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
