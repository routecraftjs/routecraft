import {
  direct,
  error as rcError,
  type DirectDestinationOptions,
  type DirectSourceOptions,
  type Exchange,
  type Source,
  type Destination,
} from "@routecraft/routecraft";

/**
 * Options for mcp() when used as a Source in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface McpSourceOptions extends DirectSourceOptions {
  /** Human-readable description (required for MCP tools). */
  description: string;
}

/**
 * Options for mcp() when used as a Destination in .to().
 */
export type McpDestinationOptions = DirectDestinationOptions;

export type McpOptions = McpSourceOptions;

/**
 * Create an MCP endpoint - a discoverable direct route for AI/MCP integration.
 *
 * `mcp()` is an alias for `direct()` with semantics oriented toward AI/MCP use cases.
 * Same two-argument pattern: mcp(endpoint, options) for source, mcp(endpoint) for destination.
 */
export function mcp<T = unknown>(
  endpoint: string,
  options: McpSourceOptions,
): Source<T>;
export function mcp<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
): Destination<T, T>;
export function mcp<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: McpSourceOptions | McpDestinationOptions,
): Source<T> | Destination<T, T> {
  if (options !== undefined) {
    if (typeof endpoint !== "string") {
      throw rcError("RC5010", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          "Use a static string endpoint for source: .from(mcp('endpoint', options)).",
      });
    }
    return direct<T>(endpoint, options);
  }
  return direct<T>(endpoint);
}
