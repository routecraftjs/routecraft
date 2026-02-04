import {
  direct,
  type DirectAdapter,
  type DirectDestinationOptions,
  type DirectSourceOptions,
  type Exchange,
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

/** @deprecated Use ToolSourceOptions or ToolDestinationOptions. Kept for backward compatibility. */
export type ToolOptions = ToolSourceOptions;

/**
 * Create a tool - a discoverable direct route for AI/MCP integration.
 *
 * `tool()` is an alias for `direct()` with semantics oriented toward AI use cases.
 * Use `tool()` when building routes that will be discovered and called by AI agents
 * or exposed via MCP.
 *
 * @example
 * ```typescript
 * import { tool } from '@routecraft/ai'
 * import { z } from 'zod'
 *
 * // Define a tool with schema and description for AI discovery
 * craft()
 *   .from(tool('fetch-webpage', {
 *     description: 'Fetch and return the content of a webpage',
 *     schema: z.object({
 *       url: z.string().url(),
 *       includeImages: z.boolean().optional()
 *     }),
 *     keywords: ['fetch', 'web', 'http', 'scrape']
 *   }))
 *   .process(async ({ url, includeImages }) => {
 *     const response = await fetch(url)
 *     return { content: await response.text() }
 *   })
 * ```
 *
 * @example
 * ```typescript
 * // Call a tool from another route
 * craft()
 *   .from(source)
 *   .to(tool('fetch-webpage'))
 * ```
 *
 * @example
 * ```typescript
 * // Dynamic tool routing (destination only)
 * craft()
 *   .from(source)
 *   .to(tool((ex) => `processor-${ex.body.type}`))
 * ```
 */
export function tool<T = unknown>(
  endpoint: string,
  options: ToolSourceOptions,
): DirectAdapter<T>;
export function tool<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: ToolDestinationOptions,
): DirectAdapter<T>;
export function tool<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: ToolSourceOptions | ToolDestinationOptions,
): DirectAdapter<T> {
  return direct<T>(endpoint, options);
}
