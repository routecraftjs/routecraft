import type { Exchange, Enricher } from "@routecraft/routecraft";
import {
  getExchangeContext,
  HeadersKeys,
  rcError,
  sendsTraceContext,
  traceContextOf,
} from "@routecraft/routecraft";
import type {
  McpClientOptions,
  McpArgsExtractor,
  McpClientAuthOptions,
  McpClientHttpConfig,
} from "../../types.ts";
import { MCP } from "../../port.ts";
import { McpHeadersKeys } from "../../types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";
import {
  callRemoteToolRaw,
  dispatchMcpCallRaw,
  recordHopResult,
  relayRemoteError,
  toolResultBody,
} from "../../dispatch.ts";

/** Ensure inline url is HTTP(S) only. Stdio clients are reached via dispatchMcpCall. */
function assertHttpUrl(url: string): void {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error(
      `MCP client: url must be HTTP or HTTPS. Stdio is not supported in routes; register stdio clients via mcpPlugin({ clients: { name: { command, args } } }). Got: "${url.slice(0, 50)}${url.length > 50 ? "..." : ""}"`,
    );
  }
}

/**
 * Look up the registered server config from the MCP plugin.
 * Returns undefined when no context or no matching serverId.
 * Backward-compat: store value may be a plain string (url only).
 */
function resolveServerConfig(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): McpClientHttpConfig | string | undefined {
  if (!options.serverId || !context) return undefined;
  const servers = context.lookup(MCP)?.clients;
  const cfg = servers?.get(options.serverId);
  if (cfg && typeof cfg === "object" && "transport" in cfg) {
    // stdio configs surface through dispatchMcpCall; resolveConnection only
    // needs the http variant for the inline-URL or http-serverId fall-through.
    return undefined;
  }
  return cfg as McpClientHttpConfig | string | undefined;
}

/**
 * Resolves the URL and auth for the MCP server from options or context (serverId).
 * Returns both in a single lookup to avoid duplicate store reads.
 */
function resolveConnection(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): { url: string; auth?: McpClientAuthOptions | undefined } {
  if (options.url) {
    assertHttpUrl(options.url);
    return { url: options.url, auth: options.auth };
  }
  if (options.serverId && !context) {
    throw new Error(
      `MCP client: serverId "${options.serverId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so the MCP plugin's clients can be read.`,
    );
  }
  if (options.serverId && context) {
    const config = resolveServerConfig(options, context);
    if (!config) {
      throw new Error(
        `MCP client: serverId "${options.serverId}" is not a registered MCP client. Register it via mcpPlugin({ clients }).`,
      );
    }
    const url = typeof config === "string" ? config : config.url;
    const auth =
      options.auth ??
      (typeof config === "object" && "auth" in config
        ? config.auth
        : undefined);
    return { url, auth };
  }
  throw new Error(
    "MCP client: either url or serverId must be provided in McpClientOptions.",
  );
}

/** Where a call's metadata lives, beside the result rather than inside it. */
const metadataOf = new WeakMap<object, Record<string, unknown>>();

/**
 * Default args extractor: use exchange body as tool arguments.
 * If body is a non-null object, use it as the args; otherwise use { input: body }.
 */
export const defaultArgs: McpArgsExtractor = (exchange) =>
  typeof exchange.body === "object" && exchange.body !== null
    ? (exchange.body as Record<string, unknown>)
    : { input: exchange.body };

/**
 * McpEnricherAdapter implements the Enricher (fetch) role for the MCP adapter.
 *
 * This adapter is used when mcp() is called with client options:
 * - `mcp({ url, tool })` - Direct HTTP URL
 * - `mcp({ serverId, tool })` - Server registered via mcpPlugin
 * - `mcp('server:tool')` - Shorthand for serverId:tool
 *
 * It makes HTTP calls to remote MCP servers using the MCP SDK.
 */
export class McpEnricherAdapter implements Enricher<unknown, unknown> {
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

  async fetch(exchange: Exchange<unknown>): Promise<unknown> {
    const toolName = this.resolveToolName(exchange);
    try {
      return await this.call(exchange, toolName);
    } catch (error) {
      // The hop to the tool the caller named: its error text is the remote's
      // answer to that caller, which the MCP server relays for this route.
      if (
        typeof this.options.serverId === "string" &&
        exchange.headers[McpHeadersKeys.CLIENT] === this.options.serverId &&
        exchange.headers[McpHeadersKeys.TOOL] === toolName
      ) {
        relayRemoteError(
          error,
          exchange.headers[HeadersKeys.ROUTE_ID] as string,
        );
      }
      throw error;
    }
  }

  private async call(
    exchange: Exchange<unknown>,
    toolName: string,
  ): Promise<unknown> {
    const context = getExchangeContext(exchange);
    const argsExtractor = this.options.args ?? defaultArgs;
    const args = argsExtractor(exchange);
    const own = this.options.traceContext;

    // serverId path -> registered MCP client (stdio or http). Delegates
    // to `dispatchMcpCall` so transport selection (stdio manager vs
    // one-shot HTTP client), missing-client diagnostics, and resource
    // cleanup all live in one place shared with the agent
    // `tools([...])` resolver.
    if (this.options.serverId) {
      if (!context) {
        throw new Error(
          `MCP client: serverId "${this.options.serverId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route).`,
        );
      }
      const transport = resolveServerTransport(context, this.options.serverId);
      const raw = await dispatchMcpCallRaw(
        context.lookup(MCP),
        this.options.serverId,
        toolName,
        args,
        { context, own, carrier: () => traceContextOf(exchange) },
      );
      const result = toolResultBody(
        raw,
        `"${this.options.serverId}:${toolName}"`,
      );
      // Only a proxied call's own hop: the server answers that call, and
      // nothing reads a record for any other exchange.
      if (exchange.headers[McpHeadersKeys.CLIENT] === this.options.serverId) {
        recordHopResult(exchange.id, result, raw);
      }
      if (result && typeof result === "object") {
        metadataOf.set(result, {
          toolName,
          transport,
          serverId: this.options.serverId,
        });
      }
      return result;
    }

    // Inline-URL path -> direct HTTP call without going through the
    // registry. Uses the shared `callRemoteTool` helper so transport
    // setup, auth-header building, and cleanup stay aligned with
    // `dispatchMcpCall`.
    const { url, auth } = resolveConnection(this.options, context);
    const raw = await callRemoteToolRaw(
      url,
      toolName,
      args,
      auth,
      // `_meta.traceparent` and `_meta.tracestate`, as SEP-414 names them.
      sendsTraceContext(context, own)
        ? { ...traceContextOf(exchange) }
        : undefined,
    );
    // The URL is configuration, not part of the answer, as in callRemoteTool.
    const result = toolResultBody(raw, `"${toolName}"`);
    if (result && typeof result === "object") {
      metadataOf.set(result, { toolName, url, transport: "http" });
    }
    return result;
  }

  /**
   * The tool this call invokes. `"*"` forwards the tool a route proxying
   * this same client named on the exchange: `McpHeadersKeys.CLIENT` must be
   * this client and `McpHeadersKeys.TOOL` the remote tool. The client check
   * is what keeps the star form from forwarding a local `.from(mcp())`
   * route's own name (the server sets `TOOL` on every call) or another
   * client's tool names with this client's credentials; either is a wiring
   * error, named as such.
   */
  private resolveToolName(exchange: Exchange<unknown>): string {
    const tool = this.options.tool;
    if (typeof tool !== "string" || tool === "") {
      throw rcError("RC5003", undefined, {
        message: "mcp(): tool name required",
        suggestion:
          'Set tool on the client options, use the mcp("server:tool") shorthand, or mcp("server:*") on a route that proxies the server.',
      });
    }
    if (tool !== "*") return tool;
    const serverId = this.options.serverId;
    const named = exchange.headers[McpHeadersKeys.TOOL];
    const client = exchange.headers[McpHeadersKeys.CLIENT];
    if (
      serverId === undefined ||
      typeof named !== "string" ||
      named === "" ||
      typeof client !== "string"
    ) {
      throw rcError("RC5003", undefined, {
        message: `mcp("${serverId ?? this.options.url}:*"): the exchange names no proxied tool`,
        suggestion:
          'The star form forwards the tool a route proxying a registered client (.from(mcp({ proxy }))) named on the routecraft.mcp.tool and routecraft.mcp.client headers. On any other route name the tool: mcp("server:tool").',
      });
    }
    if (client !== serverId) {
      throw rcError("RC5003", undefined, {
        message: `mcp("${serverId}:*") on a route proxying client "${client}"`,
        suggestion: `The star form forwards to the client the route proxies. Use mcp("${client}:*"), or name the tool: mcp("${serverId}:tool").`,
      });
    }
    return named;
  }

  /**
   * Extract metadata from MCP adapter execution.
   * Keyed on the result object rather than written into it, so concurrent
   * exchanges cannot see each other's metadata and a result that is the
   * remote's structured content reaches the route exactly as published.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const known =
      result && typeof result === "object" ? metadataOf.get(result) : undefined;
    if (known !== undefined) return known;
    return {
      toolName: "unknown",
      transport: "unknown",
    };
  }
}

/**
 * Look up the transport label for a registered MCP server so the
 * destination's metadata reflects what `dispatchMcpCall` actually
 * used. Falls back to `"http"` because that's the default for
 * registered clients without an explicit transport tag (stdio configs
 * carry `transport: "stdio"` explicitly).
 */
function resolveServerTransport(
  context: NonNullable<ReturnType<typeof getExchangeContext>>,
  serverId: string,
): "stdio" | "http" {
  const servers = context.lookup(MCP)?.clients;
  const cfg = servers?.get(serverId);
  if (
    cfg &&
    typeof cfg === "object" &&
    "transport" in cfg &&
    (cfg as { transport: string }).transport === "stdio"
  ) {
    return "stdio";
  }
  return "http";
}
