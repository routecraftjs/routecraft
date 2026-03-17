import type { McpClientAuthOptions } from "./types.ts";

/**
 * Build HTTP headers from MCP client auth options.
 * Returns undefined when no headers are needed.
 * @internal
 */
export function buildAuthHeaders(
  auth?: McpClientAuthOptions,
): Record<string, string> | undefined {
  if (!auth) return undefined;

  const headers: Record<string, string> = {};
  if (auth.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }
  if (auth.headers) {
    Object.assign(headers, auth.headers);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
