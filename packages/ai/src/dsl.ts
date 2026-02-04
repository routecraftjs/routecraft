import { direct, type DirectAdapterOptions } from "@routecraft/routecraft";
import type { DirectAdapter } from "@routecraft/routecraft";

/**
 * Options for creating a tool (extends DirectAdapterOptions).
 *
 * Tools are discoverable direct routes designed for AI/MCP integration.
 * When providing options, `description` is required so tools are always discoverable.
 */
export interface ToolOptions extends DirectAdapterOptions {
  /** Human-readable description of what this tool does (required for discovery). */
  description: string;
}

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
  endpoint:
    | string
    | ((exchange: import("@routecraft/routecraft").Exchange<T>) => string),
  options?: ToolOptions,
): DirectAdapter<T> {
  return direct<T>(endpoint, options);
}
