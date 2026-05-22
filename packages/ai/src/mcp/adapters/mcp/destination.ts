import type { Exchange, Destination } from "@routecraft/routecraft";
import { getExchangeContext } from "@routecraft/routecraft";
import type {
  McpClientOptions,
  McpArgsExtractor,
  McpClientAuthOptions,
  McpClientHttpConfig,
} from "../../types.ts";
import { ADAPTER_MCP_CLIENT_SERVERS } from "../../types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";
import { callRemoteTool, dispatchMcpCall } from "../../dispatch.ts";

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
 * Look up the registered server config from the context store.
 * Returns undefined when no context or no matching serverId.
 * Backward-compat: store value may be a plain string (url only).
 */
function resolveServerConfig(
  options: McpClientOptions,
  context: ReturnType<typeof getExchangeContext>,
): McpClientHttpConfig | string | undefined {
  if (!options.serverId || !context) return undefined;
  const servers = context.getStore(ADAPTER_MCP_CLIENT_SERVERS);
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

/**
 * Default args extractor: use exchange body as tool arguments.
 * If body is a non-null object, use it as the args; otherwise use { input: body }.
 *
 * @beta
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
      const result = await dispatchMcpCall(
        context,
        this.options.serverId,
        toolName,
        args,
      );
      if (result && typeof result === "object") {
        (result as Record<string, unknown>)["metadata"] = {
          toolName,
          transport,
          serverId: this.options.serverId,
        };
      }
      return result;
    }

    // Inline-URL path -> direct HTTP call without going through the
    // registry. Uses the shared `callRemoteTool` helper so transport
    // setup, auth-header building, and cleanup stay aligned with
    // `dispatchMcpCall`.
    const { url, auth } = resolveConnection(this.options, context);
    const result = await callRemoteTool(url, toolName, args, auth);
    if (result && typeof result === "object") {
      (result as Record<string, unknown>)["metadata"] = {
        toolName,
        url,
        transport: "http",
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
  const servers = context.getStore(ADAPTER_MCP_CLIENT_SERVERS);
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
