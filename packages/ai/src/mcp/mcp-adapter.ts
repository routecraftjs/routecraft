import {
  error as rcError,
  type Exchange,
  type ExchangeHeaders,
  type Source,
  type Destination,
  type CraftContext,
} from "@routecraft/routecraft";
import { BRAND } from "../brand.ts";
import { McpClient } from "./client-adapter.ts";
import { McpServer } from "./source-adapter.ts";
import type {
  McpArgsExtractor,
  McpClientOptions,
  McpServerOptions,
} from "./types.ts";

type McpDelegate<T = unknown> = McpServer<T> | McpClient;

/**
 * MCP adapter facade: single exported adapter for both server (.from) and client (.to) roles.
 * Delegates to internal McpServer or McpClient. Use via mcp(); do not instantiate internal classes.
 */
export class McpAdapter<T = unknown>
  implements Source<T>, Destination<unknown, unknown>
{
  readonly adapterId = "routecraft.adapter.mcp";

  private readonly delegate: McpDelegate<T>;

  constructor(
    endpointOrOptions:
      | string
      | ((exchange: Exchange<T>) => string)
      | McpClientOptions,
    options?: McpServerOptions | { args?: McpArgsExtractor },
  ) {
    (this as unknown as Record<symbol, boolean>)[BRAND.McpAdapter] = true;

    // Client: object with url or serverId
    if (
      typeof endpointOrOptions === "object" &&
      endpointOrOptions !== null &&
      ("url" in endpointOrOptions || "serverId" in endpointOrOptions)
    ) {
      this.delegate = new McpClient(endpointOrOptions as McpClientOptions);
      return;
    }

    // Client: "server:tool" string with optional args
    const isClientColonOptions =
      options === undefined ||
      (typeof options === "object" &&
        options !== null &&
        !("description" in options));
    if (
      typeof endpointOrOptions === "string" &&
      endpointOrOptions.includes(":") &&
      isClientColonOptions
    ) {
      const colonIndex = endpointOrOptions.indexOf(":");
      const serverId = endpointOrOptions.slice(0, colonIndex);
      const tool = endpointOrOptions.slice(colonIndex + 1);
      const clientOptions: McpClientOptions = { serverId, tool };
      if (
        options !== undefined &&
        typeof options === "object" &&
        "args" in options &&
        options.args !== undefined
      ) {
        clientOptions.args = options.args as McpArgsExtractor;
      }
      this.delegate = new McpClient(clientOptions);
      return;
    }

    // Server: endpoint + options with description
    const endpoint = endpointOrOptions as
      | string
      | ((exchange: Exchange<T>) => string);
    if (options !== undefined) {
      this.validateServerArgs(endpoint, options);
      this.delegate = new McpServer<T>(
        endpoint as string,
        options as McpServerOptions,
      );
      return;
    }

    // Invalid: endpoint only (no options) — direct not supported
    throw rcError("RC5003", undefined, {
      message:
        "mcp() with only an endpoint is not supported. Use direct('endpoint') for in-process. For MCP server use .from(mcp('endpoint', { description: '...' })); for client use .to(mcp({ url, tool })) or .to(mcp('server:tool', { args })).",
      suggestion:
        "Use .from(mcp('endpoint', { description: '...' })) or .to(mcp({ url, tool })) or direct('endpoint').",
    });
  }

  private validateServerArgs(
    endpoint: string | ((exchange: Exchange<T>) => string),
    options: McpServerOptions | { args?: McpArgsExtractor },
  ): void {
    if (typeof endpoint !== "string") {
      throw rcError("RC5003", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          "Use a static string endpoint for source: .from(mcp('endpoint', options)).",
      });
    }
    if ("url" in options || "serverId" in options) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp() with url or serverId must be used as destination: .to(mcp({ url, tool }))",
        suggestion:
          "Use .to(mcp({ url: '...', tool: '...' })) to call a remote MCP server.",
      });
    }
    if (
      "args" in options &&
      options.args !== undefined &&
      !("description" in options)
    ) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp(endpoint, { args }) is for client usage with a 'server:tool' target, not for defining a source",
        suggestion:
          "Use .to(mcp('server:tool', { args })) to call a remote tool, or .from(mcp('endpoint', { description: '...' })) to define a source.",
      });
    }
    if (
      !("description" in options) ||
      typeof (options as { description?: unknown }).description !== "string"
    ) {
      throw rcError("RC5003", undefined, {
        message:
          "mcp(endpoint, options) as source requires options.description",
        suggestion:
          "Use .from(mcp('endpoint', { description: '...' })) to define a source.",
      });
    }
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    if (!(this.delegate instanceof McpServer)) {
      throw rcError("RC5003", undefined, {
        message:
          "This MCP adapter was created as a client; cannot use with .from()",
        suggestion:
          "Use .from(mcp('endpoint', { description: '...' })) for a source.",
      });
    }
    return this.delegate.subscribe(context, handler, abortController, onReady);
  }

  async send(exchange: Exchange<unknown>): Promise<unknown> {
    if (!(this.delegate instanceof McpClient)) {
      throw rcError("RC5003", undefined, {
        message:
          "This MCP adapter was created as a server; cannot use with .to()",
        suggestion:
          "Use .to(mcp({ url, tool })) or .to(mcp('server:tool', { args })) for a client.",
      });
    }
    return this.delegate.send(exchange);
  }
}
