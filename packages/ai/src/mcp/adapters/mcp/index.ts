import {
  rcError,
  tagAdapter,
  factoryArgs,
  type Source,
  type Destination,
} from "@routecraft/routecraft";
import type {
  McpArgsExtractor,
  McpClientOptions,
  McpServerOptions,
} from "../../types.ts";
import type { RegisteredMcpShorthand } from "../../../registry.ts";
import { McpSourceAdapter } from "./source.ts";
import { McpDestinationAdapter } from "./destination.ts";
import type { McpMessage } from "./types.ts";

/**
 * Creates an MCP adapter.
 *
 * - **Source (for `.from()`):** Call with no arguments or with MCP-protocol
 *   options (`annotations`, `icons`). The tool name is the route id; the
 *   description, title, and input / output schemas come from the route
 *   builder (`.description()`, `.title()`, `.input()`, `.output()`) and a
 *   non-empty `.description()` is required. Requires `mcpPlugin()`.
 *
 * - **Destination (for `.to()` / `.tap()`):** Call with client options:
 *   - `mcp({ url, tool })` - Direct HTTP URL to remote MCP server
 *   - `mcp({ serverId, tool })` - Server ID registered via mcpPlugin({ clients })
 *   - `mcp('server:tool', { args? })` - Shorthand for serverId:tool with optional args extractor
 *
 * @experimental
 *
 * @example
 * ```ts
 * // Source route (tool name = route id)
 * craft()
 *   .id("search")
 *   .description("Search documents")
 *   .input({ body: mySchema })
 *   .from(mcp({ annotations: { readOnlyHint: true } }))
 *
 * // Destination (call remote MCP server)
 * .to(mcp({ url: 'http://localhost:3001/mcp', tool: 'search' }))
 * .to(mcp({ serverId: 'my-server', tool: 'search' }))
 * .to(mcp('my-server:search'))
 * .to(mcp('my-server:search', { args: (ex) => ex.body.params }))
 * ```
 */
export function mcp(options?: McpServerOptions): Source<McpMessage<undefined>>;
export function mcp(
  clientOptions: McpClientOptions,
): Destination<unknown, unknown>;
export function mcp(
  shorthand: RegisteredMcpShorthand,
  options?: { args?: McpArgsExtractor },
): Destination<unknown, unknown>;
export function mcp(
  arg?: McpServerOptions | McpClientOptions | RegisteredMcpShorthand,
  options?: { args?: McpArgsExtractor },
): Source<McpMessage<undefined>> | Destination<unknown, unknown> {
  // Client (object): url or serverId present
  if (
    typeof arg === "object" &&
    arg !== null &&
    ("url" in arg || "serverId" in arg)
  ) {
    const clientOpts = arg as McpClientOptions;
    if (typeof clientOpts.auth?.token === "string") {
      if (clientOpts.auth.token.trim().length === 0) {
        throw new TypeError(
          "mcp(): auth.token must be a non-empty string when provided",
        );
      }
    }
    if (Array.isArray(clientOpts.auth?.token)) {
      if (clientOpts.auth.token.length === 0) {
        throw new TypeError("mcp(): auth.token array must not be empty");
      }
      for (let i = 0; i < clientOpts.auth.token.length; i++) {
        const entry = clientOpts.auth.token[i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new TypeError(
            `mcp(): auth.token[${i}] must be a non-empty string`,
          );
        }
      }
    }
    return tagAdapter(
      new McpDestinationAdapter(clientOpts),
      mcp,
      factoryArgs(arg, options),
    );
  }

  // Client: "server:tool" shorthand string
  if (typeof arg === "string" && arg.includes(":")) {
    const colonIndex = arg.indexOf(":");
    const serverId = arg.slice(0, colonIndex);
    const tool = arg.slice(colonIndex + 1);
    const clientOptions: McpClientOptions = { serverId, tool };
    if (
      options !== undefined &&
      typeof options === "object" &&
      "args" in options &&
      options.args !== undefined
    ) {
      clientOptions.args = options.args as McpArgsExtractor;
    }
    return tagAdapter(
      new McpDestinationAdapter(clientOptions),
      mcp,
      factoryArgs(arg, options),
    );
  }

  // A bare string without a colon is not a valid call: it is neither
  // a client shorthand (requires "server:tool") nor a source options
  // object. Point users at the right overload.
  if (typeof arg === "string") {
    throw rcError("RC5003", undefined, {
      message: `mcp(${JSON.stringify(arg)}) is not a valid call: a bare string without ":" is neither a client shorthand nor source options`,
      suggestion:
        "Use .from(mcp()) for a source (tool name comes from .id()), .to(mcp({ url, tool })) for a remote server, .to(mcp('server:tool')) for a registered shorthand, or direct('name') for in-process dispatch.",
    });
  }

  // Source: undefined or server options (annotations / icons)
  return tagAdapter(
    new McpSourceAdapter((arg as McpServerOptions) ?? {}),
    mcp,
    factoryArgs(arg, options),
  );
}

// Re-export types for public API
export type {
  McpMessage,
  McpArgsExtractor,
  McpClientHttpConfig,
} from "./types";
export { BRAND_MCP_ADAPTER } from "./shared";
export { defaultArgs } from "./destination";
