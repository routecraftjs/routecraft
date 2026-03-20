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

  if (auth.token !== undefined && auth.token.length === 0) {
    throw new Error(
      "McpClientAuthOptions.token must be a non-empty string when provided",
    );
  }

  const headers: Record<string, string> = {};
  const customHeaders = auth.headers ?? {};

  // Check if custom headers provide an Authorization override (case-insensitive)
  const authorizationOverride = Object.entries(customHeaders).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];

  if (authorizationOverride) {
    headers["Authorization"] = authorizationOverride;
  } else if (auth.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }

  // Merge remaining custom headers, skipping any authorization variant
  for (const [name, value] of Object.entries(customHeaders)) {
    if (name.toLowerCase() !== "authorization") {
      headers[name] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
