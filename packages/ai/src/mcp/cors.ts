/**
 * CORS for the MCP HTTP transport.
 *
 * Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors,
 * web-hosted Claude Desktop) cannot read responses from the MCP HTTP transport
 * without CORS headers. This module owns the policy and the header math.
 *
 * The default is **loopback-only**: a request whose `Origin` is on `localhost`,
 * `127.0.0.1`, or `[::1]` (any port, http or https) gets reflected; everything
 * else gets no `Access-Control-Allow-Origin` header back and is blocked by the
 * browser. This is intentionally production-safe by construction: local
 * browser tooling works with zero config, while production deployments must
 * opt their real origins in explicitly. See `.standards/security.md` ->
 * "Security defaults policy" for the broader principle.
 *
 * Server-to-server callers (curl, `mcp-remote`, the MCP CLI) are unaffected by
 * CORS because they do not send an `Origin` header.
 *
 * @experimental
 */

/**
 * Resolver form of `origin`. Receives the request's `Origin` header (or
 * `undefined` when absent) and returns either the value to echo in
 * `Access-Control-Allow-Origin`, or `false` to disallow.
 *
 * Keeping this transport-agnostic (no `IncomingMessage`) lets the helper run
 * on Bun, Node, and in tests without coupling to `node:http`.
 *
 * @experimental
 */
export type McpCorsOriginResolver = (
  requestOrigin: string | undefined,
) => string | false;

/**
 * CORS configuration for the MCP HTTP transport. Passed via
 * `mcpPlugin({ cors: { ... } })`.
 *
 * Omitting `cors` entirely applies the loopback-only default. Pass `cors: false`
 * on `McpPluginOptions` to disable CORS handling completely (useful when a
 * reverse proxy or CDN owns CORS).
 *
 * @experimental
 */
export interface McpCorsOptions {
  /**
   * Allowed origin(s).
   *
   * - `"*"` -- permissive, no `Vary: Origin` emitted.
   * - `string` -- exact match against the request `Origin`; non-match returns no allow header.
   * - `string[]` -- allowlist; if the request `Origin` matches one entry, it is reflected.
   * - {@link McpCorsOriginResolver} -- custom resolver, returns the value to echo or `false` to disallow.
   *
   * Omitting this property falls back to the loopback allowlist.
   */
  origin?: "*" | string | string[] | McpCorsOriginResolver;
  /** Methods allowed on `/mcp` and the metadata endpoint. Default: `["GET", "POST", "OPTIONS"]`. */
  allowMethods?: string[];
  /** Request headers permitted on cross-origin requests. Default: `["*"]`. */
  allowHeaders?: string[];
  /**
   * Response headers exposed to the browser. `WWW-Authenticate` is always
   * exposed by default so browser clients can read the RFC 9728
   * `resource_metadata` hint on a 401. Custom values are additive with this default.
   */
  exposeHeaders?: string[];
  /**
   * Whether to set `Access-Control-Allow-Credentials: true`. Cannot be combined
   * with `origin: "*"` per the CORS spec; an explicit origin or allowlist is required.
   * Default: `false`.
   */
  credentials?: boolean;
  /** Preflight cache duration in seconds. Default: omitted (browser default). */
  maxAge?: number;
}

/**
 * Internal resolved CORS shape. Always fully populated; the consumer never has
 * to branch on string vs array vs function.
 *
 * @internal
 */
export interface ResolvedMcpCors {
  resolveOrigin: McpCorsOriginResolver;
  /** `true` when `origin` was the literal `"*"`. Skips `Vary: Origin`. */
  isWildcard: boolean;
  allowMethods: string;
  allowHeaders: string;
  exposeHeaders: string;
  credentials: boolean;
  maxAge: number | undefined;
}

/**
 * Hostnames recognised as loopback by the default policy. IPv6 loopback
 * appears as both `::1` and bracketed `[::1]` in `Origin` headers depending on
 * the client; both are accepted.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Default origin resolver: reflect the request `Origin` iff it is loopback.
 * Returns `false` otherwise.
 *
 * @internal
 */
export function defaultLoopbackOriginResolver(
  requestOrigin: string | undefined,
): string | false {
  if (!requestOrigin) return false;
  let parsed: URL;
  try {
    parsed = new URL(requestOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname) ? requestOrigin : false;
}

const DEFAULT_ALLOW_METHODS = ["GET", "POST", "OPTIONS"];
const DEFAULT_ALLOW_HEADERS = ["*"];
const DEFAULT_EXPOSE_HEADERS = ["WWW-Authenticate"];

/**
 * Resolve a `cors` config slot into either a fully-populated internal shape or
 * `null` (CORS disabled entirely). `undefined` produces the loopback default.
 *
 * @internal
 */
export function resolveCorsOptions(
  input: false | McpCorsOptions | undefined,
): ResolvedMcpCors | null {
  if (input === false) return null;
  const opts = input ?? {};

  const credentials = opts.credentials === true;

  let resolveOrigin: McpCorsOriginResolver;
  let isWildcard = false;
  if (opts.origin === undefined) {
    resolveOrigin = defaultLoopbackOriginResolver;
  } else if (opts.origin === "*") {
    if (credentials) {
      throw new TypeError(
        "mcpPlugin: cors.credentials cannot be true when cors.origin is '*' (per the CORS spec). " +
          "Use an explicit origin string, an allowlist, or a resolver function.",
      );
    }
    resolveOrigin = () => "*";
    isWildcard = true;
  } else if (typeof opts.origin === "string") {
    const allowed = opts.origin;
    resolveOrigin = (requestOrigin) =>
      requestOrigin === allowed ? allowed : false;
  } else if (Array.isArray(opts.origin)) {
    const allowed = new Set(opts.origin);
    resolveOrigin = (requestOrigin) =>
      requestOrigin !== undefined && allowed.has(requestOrigin)
        ? requestOrigin
        : false;
  } else if (typeof opts.origin === "function") {
    resolveOrigin = opts.origin;
  } else {
    throw new TypeError(
      "mcpPlugin: cors.origin must be '*', a string, a string array, or a function",
    );
  }

  const exposeHeaders = mergeExposeHeaders(opts.exposeHeaders);

  return {
    resolveOrigin,
    isWildcard,
    allowMethods: (opts.allowMethods ?? DEFAULT_ALLOW_METHODS).join(", "),
    allowHeaders: (opts.allowHeaders ?? DEFAULT_ALLOW_HEADERS).join(", "),
    exposeHeaders,
    credentials,
    maxAge: opts.maxAge,
  };
}

/**
 * Merge user-supplied `exposeHeaders` with the `WWW-Authenticate` default,
 * deduplicating case-insensitively. The default exists so browser clients can
 * read the RFC 9728 `resource_metadata` hint on a 401.
 */
function mergeExposeHeaders(user: string[] | undefined): string {
  const merged = [...DEFAULT_EXPOSE_HEADERS];
  if (user) {
    const lower = new Set(merged.map((h) => h.toLowerCase()));
    for (const h of user) {
      if (!lower.has(h.toLowerCase())) {
        merged.push(h);
        lower.add(h.toLowerCase());
      }
    }
  }
  return merged.join(", ");
}

/**
 * Build the response headers to add for a given request `Origin`. Returns an
 * empty object when CORS is disabled or the request `Origin` is disallowed.
 *
 * The caller is responsible for setting these headers on the response. The
 * helper is pure to keep it testable in isolation and reusable from both the
 * raw-`node:http` (validator) and Express (OAuth-proxy) paths.
 *
 * @param cors Resolved CORS options, or `null` to short-circuit.
 * @param requestOrigin Value of the request's `Origin` header.
 * @param preflight `true` to include `Access-Control-Allow-Methods/Headers/Max-Age`.
 * @internal
 */
export function buildCorsHeaders(
  cors: ResolvedMcpCors | null,
  requestOrigin: string | undefined,
  preflight: boolean,
): Record<string, string> {
  if (!cors) return {};
  const allowed = cors.resolveOrigin(requestOrigin);
  if (allowed === false) return {};

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Expose-Headers": cors.exposeHeaders,
  };
  if (!cors.isWildcard) {
    headers["Vary"] = "Origin";
  }
  if (cors.credentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (preflight) {
    headers["Access-Control-Allow-Methods"] = cors.allowMethods;
    headers["Access-Control-Allow-Headers"] = cors.allowHeaders;
    if (cors.maxAge !== undefined) {
      headers["Access-Control-Max-Age"] = String(cors.maxAge);
    }
  }
  return headers;
}
