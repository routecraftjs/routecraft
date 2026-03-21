import type { McpClientAuthOptions } from "./types.ts";

/** Round-robin index for array tokens, keyed by the array reference. */
const rrIndexes = new WeakMap<string[], number>();

/**
 * Resolve the raw token value from the various accepted forms.
 * @internal
 */
async function resolveToken(
  token: NonNullable<McpClientAuthOptions["token"]>,
): Promise<string> {
  if (typeof token === "function") {
    return token();
  }
  if (Array.isArray(token)) {
    if (token.length === 0) {
      throw new Error("McpClientAuthOptions.token array must not be empty");
    }
    const idx = (rrIndexes.get(token) ?? 0) % token.length;
    rrIndexes.set(token, idx + 1);
    return token[idx];
  }
  return token;
}

/**
 * Build HTTP headers from MCP client auth options.
 * Returns undefined when no headers are needed.
 * @internal
 */
export async function buildAuthHeaders(
  auth?: McpClientAuthOptions,
): Promise<Record<string, string> | undefined> {
  if (!auth) return undefined;

  const headers: Record<string, string> = {};
  const customHeaders = auth.headers ?? {};

  // Check if custom headers provide an Authorization override (case-insensitive)
  const authorizationOverride = Object.entries(customHeaders).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];

  if (authorizationOverride) {
    headers["Authorization"] = authorizationOverride;
  } else if (auth.token !== undefined) {
    const resolved = await resolveToken(auth.token);
    if (resolved.length === 0) {
      throw new Error(
        "McpClientAuthOptions.token must be a non-empty string when provided",
      );
    }
    headers["Authorization"] = `Bearer ${resolved}`;
  }

  // Merge remaining custom headers, skipping any authorization variant
  for (const [name, value] of Object.entries(customHeaders)) {
    if (name.toLowerCase() !== "authorization") {
      headers[name] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
