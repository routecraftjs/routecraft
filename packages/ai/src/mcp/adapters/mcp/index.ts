import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  rcError,
  tagAdapter,
  factoryArgs,
  type Exchange,
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
 * Creates an MCP adapter for communicating with MCP servers.
 *
 * - **Source (for `.from()`):** Call with two arguments: `mcp(endpoint, options)`.
 *   Options must include a `description` field (required for MCP tool exposure).
 *   Requires the MCP plugin: `plugins: [mcpPlugin()]`.
 *   Body type is inferred from `options.input.body` when provided.
 *
 * - **Destination (for `.to()` / `.tap()`):** Call with one argument containing client options:
 *   - `mcp({ url, tool })` - Direct HTTP URL to remote MCP server
 *   - `mcp({ serverId, tool })` - Server ID registered via mcpPlugin({ clients })
 *   - `mcp('server:tool', { args? })` - Shorthand for serverId:tool with optional args extractor
 *
 * @param endpointOrOptions - Endpoint string (source) or client options object (destination) or 'server:tool' string (destination)
 * @param options - Server options (source) or args extractor (destination)
 * @returns Source when called with two arguments; Destination when called with one argument
 *
 * @experimental
 *
 * @example
 * ```typescript
 * // Source route (MCP tool)
 * .from(mcp('/search', {
 *   description: 'Search documents',
 *   input: { body: mySchema },
 * }))
 *
 * // Destination (call remote MCP server)
 * .to(mcp({ url: 'http://localhost:3001/mcp', tool: 'search' }))
 * .to(mcp({ serverId: 'my-server', tool: 'search' }))
 * .to(mcp('my-server:search'))
 * .to(mcp('my-server:search', { args: (ex) => ex.body.params }))
 * ```
 */
export function mcp<B extends StandardSchemaV1 | undefined = undefined>(
  endpoint: string,
  options: Omit<McpServerOptions, "input"> & {
    input?: { body?: B; headers?: StandardSchemaV1 };
  },
): Source<McpMessage<B>>;
export function mcp(
  clientOptions: McpClientOptions,
): Destination<unknown, unknown>;
export function mcp(
  shorthand: RegisteredMcpShorthand,
  options?: { args?: McpArgsExtractor },
): Destination<unknown, unknown>;
export function mcp<B extends StandardSchemaV1 | undefined = undefined>(
  endpointOrOptions:
    | string
    | ((exchange: Exchange<McpMessage<B>>) => string)
    | McpClientOptions,
  options?:
    | (Omit<McpServerOptions, "input"> & {
        input?: { body?: B; headers?: StandardSchemaV1 };
      })
    | { args?: McpArgsExtractor },
): Source<McpMessage<B>> | Destination<unknown, unknown> {
  // Client: object with url or serverId
  if (
    typeof endpointOrOptions === "object" &&
    endpointOrOptions !== null &&
    ("url" in endpointOrOptions || "serverId" in endpointOrOptions)
  ) {
    const clientOpts = endpointOrOptions as McpClientOptions;
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
      factoryArgs(endpointOrOptions, options),
    );
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
    return tagAdapter(
      new McpDestinationAdapter(clientOptions),
      mcp,
      factoryArgs(endpointOrOptions, options),
    );
  }

  // Server: endpoint + options with description
  const endpoint = endpointOrOptions as
    | string
    | ((exchange: Exchange<McpMessage<B>>) => string);
  if (options !== undefined) {
    return tagAdapter(
      new McpSourceAdapter<B>(
        endpoint as string,
        options as McpServerOptions & {
          input?: { body?: B; headers?: StandardSchemaV1 };
        },
      ),
      mcp,
      factoryArgs(endpointOrOptions, options),
    );
  }

  // Invalid: endpoint only (no options) — direct not supported
  throw rcError("RC5003", undefined, {
    message:
      "mcp() with only an endpoint is not supported. Use direct('endpoint') for in-process. For MCP server use .from(mcp('endpoint', { description: '...' })); for client use .to(mcp({ url, tool })) or .to(mcp('server:tool', { args })).",
    suggestion:
      "Use .from(mcp('endpoint', { description: '...' })) or .to(mcp({ url, tool })) or direct('endpoint').",
  });
}

// Re-export types for public API
export type {
  McpMessage,
  McpArgsExtractor,
  McpClientHttpConfig,
} from "./types";
export { BRAND_MCP_ADAPTER } from "./shared";
export { defaultArgs } from "./destination";
