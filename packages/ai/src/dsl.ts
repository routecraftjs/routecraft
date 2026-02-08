import {
  direct,
  type DirectDestinationOptions,
  type DirectSourceOptions,
  type Exchange,
  type Source,
  type Destination,
} from "@routecraft/routecraft";

/**
 * Options for tool() when used as a Source in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface ToolSourceOptions extends DirectSourceOptions {
  /** Human-readable description (required for tools). */
  description: string;
}

/**
 * Options for tool() when used as a Destination in .to().
 */
export type ToolDestinationOptions = DirectDestinationOptions;

export type ToolOptions = ToolSourceOptions;

/**
 * Create a tool - a discoverable direct route for AI/MCP integration.
 *
 * `tool()` is an alias for `direct()` with semantics oriented toward AI use cases.
 * Same two-argument pattern: tool(endpoint, options) for source, tool(endpoint) for destination.
 */
export function tool<T = unknown>(
  endpoint: string,
  options: ToolSourceOptions,
): Source<T>;
export function tool<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
): Destination<T, T>;
export function tool<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: ToolSourceOptions | ToolDestinationOptions,
): Source<T> | Destination<T, T> {
  if (options !== undefined) {
    return direct<T>(endpoint as string, options);
  }
  return direct<T>(endpoint);
}
