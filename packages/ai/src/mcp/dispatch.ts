import {
  clipText,
  isRoutecraftError,
  rcError,
  sendsTraceContext,
  type CraftContext,
  type TraceContextCarrier,
} from "@routecraft/routecraft";
// Registers AI2003 before any dispatch can throw it.
import "../errors.ts";
import { connectMcpHttpClient } from "./sdk.ts";
import { extractContent } from "./extract-content.ts";
import type { McpPinRefusal } from "./pins.ts";
import type { McpService } from "./port.ts";
import type { McpHttpConnections } from "./http-connections.ts";
import {
  type McpClientAuthOptions,
  type McpClientHttpConfig,
  type McpRawToolResult,
} from "./types.ts";

/**
 * The trace context a tool call may carry, and what has a say over whether
 * it does: the call's own `traceContext`, then the client's registration,
 * then the context's `traceContext.outbound`.
 *
 * @internal
 */
export interface McpCallTrace {
  /** The calling exchange's context, whose `traceContext.outbound` is the last word. */
  readonly context: CraftContext | undefined;
  /** The call's own `traceContext`, when it set one. */
  readonly own?: boolean | undefined;
  /** Builds the carrier, and only runs when the call sends it. */
  readonly carrier: () => TraceContextCarrier;
}

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
 *   calls on the client's connection in the service's `http`
 *   connections, the one its tool listing uses, so while that connection
 *   holds a call costs no handshake and a stateful remote sees one
 *   session per client.
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
  trace?: McpCallTrace,
): Promise<unknown> {
  return toolResultBody(
    await dispatchMcpCallRaw(service, serverId, toolName, args, trace),
    `"${serverId}:${toolName}"`,
  );
}

/**
 * The remote result each proxied call's MCP hop produced, beside the body it
 * made of it, by the MCP request the call arrived as. The server opens a
 * slot before it runs the proxy route and closes it when it answers, on
 * every path, so a record exists only while a call that can take it is in
 * flight: an agent's call through the same route, or a hop in any other
 * route, finds no slot and records nothing.
 */
const HOP_RESULTS = new Map<string, HopRecord | null>();

interface HopRecord {
  readonly body: unknown;
  readonly raw: McpRawToolResult;
  /**
   * The body's JSON when the hop recorded it. Identity alone cannot tell a
   * body the route left alone from one it edited in place, and an in-place
   * edit (a field deleted to redact it) must not let the remote's own
   * content blocks and `_meta`, which still carry the field, through.
   */
  readonly snapshot: string | undefined;
}

/**
 * Open the slot a proxied call's hop records its result into. Returns the
 * function that closes it, which the server calls on every exit.
 *
 * @internal
 */
export function openHopResult(requestId: string): () => void {
  HOP_RESULTS.set(requestId, null);
  return () => {
    HOP_RESULTS.delete(requestId);
  };
}

/**
 * Record what a proxied call's MCP hop returned: the raw remote result and
 * the body the hop set from it. Nothing is recorded without an open slot
 * for the request. A later hop on the same request replaces it.
 *
 * @internal
 */
export function recordHopResult(
  requestId: unknown,
  body: unknown,
  raw: McpRawToolResult,
): void {
  if (typeof requestId !== "string" || !HOP_RESULTS.has(requestId)) return;
  HOP_RESULTS.set(requestId, { body, raw, snapshot: snapshotOf(body) });
}

/**
 * The remote result to answer a proxied call with as published, when the
 * call's final body is still exactly what its last MCP hop set, the same
 * value and unedited: the route left the result alone, so the caller, who
 * addressed the remote, receives the remote's own content blocks,
 * `structuredContent` and `_meta`. `undefined` once any step replaced or
 * edited the body, which is the route saying it shapes the answer itself.
 *
 * @internal
 */
export function unalteredHopResult(
  requestId: string,
  body: unknown,
): McpRawToolResult | undefined {
  const hop = HOP_RESULTS.get(requestId);
  if (hop === undefined || hop === null || !Object.is(hop.body, body)) {
    return undefined;
  }
  if (hop.snapshot === undefined) return hop.raw;
  return snapshotOf(body) === hop.snapshot ? hop.raw : undefined;
}

/**
 * The JSON of an object body, `undefined` for a primitive (which cannot be
 * edited in place). A body that cannot be serialised gets a snapshot no
 * later body matches, so it is never passed through.
 */
function snapshotOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  try {
    return JSON.stringify(body);
  } catch {
    return `unserialisable:${crypto.randomUUID()}`;
  }
}

/** How much of a remote error text is kept for the caller it answers. */
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
 * The text a remote MCP server sent with a result it flagged `isError`,
 * read off the `AI2003` the call threw or off an error that wraps it.
 *
 * The `AI2003` message leaves the text out, because a message reaches logs
 * and events and the text is whatever the remote chose to write. A route
 * that decides on it (a rate limit to wait out, a missing record to answer
 * for) reads it here, in its `.error()` handler.
 *
 * @param error - What the `mcp()` hop or an agent's MCP tool threw
 * @returns The remote's text, bounded; `""` when it sent none; `undefined`
 *   when the error is not a remote tool's error
 *
 * @example
 * ```ts
 * craft()
 *   .id("read-document")
 *   .error((error) => {
 *     if (remoteErrorTextOf(error)?.includes("not found")) return { found: false };
 *     throw error;
 *   })
 *   .from(direct())
 *   .to(mcp("docs:get_document"));
 * ```
 */
export function remoteErrorTextOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const text = REMOTE_TEXT.get(current);
    if (text !== undefined) return text;
    current = current.cause;
  }
  return undefined;
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
 * summarise. The error names the tool. The remote's text is its answer to
 * the caller, so it is held beside the error, bounded, and stays off the
 * message: a message reaches logs and events, and the remote writes that
 * text.
 *
 * @throws AI2003 when the result is flagged `isError`
 * @internal
 */
export function toolResultBody(raw: McpRawToolResult, where: string): unknown {
  if (raw.isError === true) {
    const text = remoteErrorText(raw);
    const error = rcError("AI2003", undefined, {
      message: `Remote MCP tool ${where} reported an error`,
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

const PIN_REFUSALS: Record<McpPinRefusal, string> = {
  unlisted:
    "the client's tools have not been listed yet, so none can be checked against the lockfile",
  added: "the lockfile has never seen this tool",
  changed: "its definition is not the one approved in the lockfile",
  absent: "the client does not list it",
};

/**
 * Dispatch an MCP tool call like {@link dispatchMcpCall} but return the raw
 * MCP `tools/call` result (content array, structuredContent, isError) that
 * {@link toolResultBody} interprets.
 *
 * Throws `RC5003` under the same conditions as {@link dispatchMcpCall}.
 *
 * Every call to a configured client passes here, a route's hop and an
 * agent's tool alike, which is what makes this the place a pinned client's
 * withheld tool is refused.
 *
 * @throws AI2004 when the client is pinned and its pins do not serve the tool
 * @internal
 */
export async function dispatchMcpCallRaw(
  service: McpService | undefined,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  trace?: McpCallTrace,
): Promise<McpRawToolResult> {
  // A disabled client is reported as disabled, not as unlisted.
  const pinned = service?.disabledClients.has(serverId)
    ? undefined
    : service?.tools.refusalOf(serverId, toolName);
  if (pinned !== undefined) {
    throw rcError("AI2004", undefined, {
      message: `MCP tool "${serverId}:${toolName}" is withheld by the client's pins: ${PIN_REFUSALS[pinned]}.`,
    });
  }
  const config = service?.clients.get(serverId);
  const registered =
    typeof config === "object" ? config.traceContext : undefined;
  const meta =
    trace !== undefined &&
    sendsTraceContext(trace.context, trace.own, registered)
      ? { ...trace.carrier() }
      : undefined;
  const manager = service?.stdio.get(serverId);
  if (manager) {
    try {
      return await manager.callToolRaw(toolName, args, meta);
    } catch (cause) {
      if (isRoutecraftError(cause)) throw cause;
      throw rcError("RC5003", cause, {
        message: `mcp dispatch: stdio call to "${serverId}:${toolName}" failed.`,
      });
    }
  }

  const { http, connections } = resolveHttpConfig(service, serverId);
  try {
    return await connections.callTool(serverId, http, toolName, args, meta);
  } catch (cause) {
    if (isRoutecraftError(cause)) throw cause;
    throw rcError("RC5003", cause, {
      message: `mcp dispatch: failed to call tool "${toolName}" on client "${serverId}".`,
    });
  }
}

/**
 * Resolve the HTTP config for a registered server id, throwing `RC5003` when
 * the server is unknown, is a string shorthand, is a stdio server whose
 * manager is absent, or has no url.
 */
function resolveHttpConfig(
  service: McpService | undefined,
  serverId: string,
): { http: McpClientHttpConfig; connections: McpHttpConnections } {
  const config = service?.clients.get(serverId);
  const disabled = service?.disabledClients.get(serverId);
  if (!config && disabled !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `mcp dispatch: client "${serverId}" is disabled (${disabled}), so it is not called.`,
    });
  }
  if (!service || !config) {
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
  return { http, connections: service.http };
}

/**
 * Open a one-shot MCP SDK client over Streamable HTTP, call the tool, then
 * close, returning the raw `tools/call` result that {@link toolResultBody}
 * interprets. Used by `McpEnricherAdapter` for inline-URL routes, which
 * have no registered client id to keep a connection under.
 *
 * @internal
 */
export async function callRemoteToolRaw(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    readonly auth?: McpClientAuthOptions | undefined;
    /** `_meta` for the call, the trace context when it is sent. */
    readonly meta?: Record<string, string> | undefined;
    readonly allowHttp?: boolean | undefined;
  } = {},
): Promise<McpRawToolResult> {
  const { meta } = options;
  let connection: Awaited<ReturnType<typeof connectMcpHttpClient>> | undefined;
  try {
    connection = await connectMcpHttpClient(new URL(serverUrl), {
      auth: options.auth,
      allowHttp: options.allowHttp,
    });
    return (await connection.client.callTool({
      name: toolName,
      arguments: args,
      ...(meta !== undefined ? { _meta: meta } : {}),
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
