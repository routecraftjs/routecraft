/**
 * CORS for browser-facing http surfaces on a named server.
 *
 * Owned by core so every surface that needs a browser to read its responses
 * (the MCP HTTP transport is the first consumer) shares one policy engine and
 * one header math, instead of each protocol mount growing a slightly
 * different copy.
 *
 * The default is **loopback-only**: a request whose `Origin` is on `localhost`,
 * `127.0.0.1`, or `::1` (any port, http or https) gets reflected; everything
 * else gets no `Access-Control-Allow-Origin` header back and is blocked by the
 * browser. This is intentionally production-safe by construction: local
 * browser tooling works with zero config, while production deployments must
 * opt their real origins in explicitly. See `.standards/security.md` ->
 * "Security defaults policy" for the broader principle.
 *
 * Server-to-server callers (curl, the craft CLI, `mcp-remote`) are unaffected
 * by CORS because they do not send an `Origin` header.
 *
 * The public option surface is intentionally minimal: only `origin` is
 * configurable. Method, header, expose-header, credentials, and preflight-cache
 * values are framework-controlled constants -- chosen to satisfy the RFC 9728
 * discovery contract and the MCP JSON-RPC handshake -- and can be expanded
 * later if a real use case demands it.
 */

/**
 * Resolver form of `origin`. Receives the request's `Origin` header (or
 * `undefined` when absent) and returns either the value to echo in
 * `Access-Control-Allow-Origin`, or `false` to disallow.
 *
 * Implementations SHOULD NOT throw. A thrown error is caught at the request
 * boundary and treated as `false` (fail-closed), but emitting an exception
 * also clears CORS for that request silently. Return `false` explicitly to
 * disallow.
 *
 * Keeping this transport-agnostic (no `IncomingMessage`) lets the helper run
 * on Bun, Node, and in tests without coupling to `node:http`.
 */
export type HttpCorsOriginResolver = (
  requestOrigin: string | undefined,
) => string | false;

/**
 * CORS configuration for a browser-facing http surface. The MCP transport
 * passes it via `mcpPlugin({ cors: { origin: ... } })`.
 *
 * Omitting the config entirely applies the loopback-only default. Consumers
 * accept `false` in their own option slot to disable CORS handling completely
 * (useful when a reverse proxy or CDN owns CORS).
 */
export interface HttpCorsOptions {
  /**
   * Allowed origin(s).
   *
   * - `"*"` -- permissive, no `Vary: Origin` emitted.
   * - `string` -- exact match against the request `Origin`; non-match returns no allow header.
   * - `string[]` -- allowlist; if the request `Origin` matches one entry, it is reflected.
   * - {@link HttpCorsOriginResolver} -- custom resolver, returns the value to echo or `false` to disallow.
   */
  origin: "*" | string | string[] | HttpCorsOriginResolver;
}

/**
 * Internal resolved CORS shape. The consumer never has to branch on string vs
 * array vs function form of `origin`. Not exported beyond this file.
 *
 * @internal
 */
interface ResolvedHttpCors {
  resolveOrigin: HttpCorsOriginResolver;
  /** `true` when `origin` was the literal `"*"`. Skips `Vary: Origin`. */
  isWildcard: boolean;
}

/**
 * Framework-controlled CORS constants. Not user-configurable; chosen to
 * satisfy the RFC 9728 discovery contract and the MCP JSON-RPC handshake.
 *
 * - `Access-Control-Allow-Methods`: the verbs the consuming transports accept.
 * - `Access-Control-Allow-Headers`: `*` is the right default; `Authorization`,
 *   `Content-Type`, and `MCP-Protocol-Version` are the headers MCP clients
 *   send today, but the spec permits more and we do not want to gate.
 * - `Access-Control-Expose-Headers` (non-preflight only): the response headers
 *   browser clients must be able to read. Only `WWW-Authenticate` (the
 *   RFC 9728 `resource_metadata` hint on a 401) qualifies: MCP protocol
 *   revision 2026-07-28 removed both `Mcp-Session-Id` (no protocol-level
 *   sessions) and SSE resumability (`Last-Event-ID`), and the stateless
 *   serving of 2025-era traffic mints neither, so nothing else is ever
 *   emitted to read.
 *
 * @internal
 */
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS = "*";
const EXPOSE_HEADERS = "WWW-Authenticate";

/**
 * Hostnames recognised as loopback by the default policy.
 *
 * IPv6: both Node and Bun's `URL.hostname` return the bracketed form
 * `"[::1]"` for `http://[::1]:8080`, not `"::1"`. The unbracketed `"::1"`
 * entry is kept as defence-in-depth in case a future URL parser surfaces it
 * (the WHATWG URL spec is unsettled on this; older parsers and some
 * synthesised inputs may produce the unbracketed form).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Default origin resolver: reflect the request `Origin` iff it is loopback
 * AND in canonical form per RFC 6454 §7.1 (`scheme://host[:port]`, no path,
 * no userinfo, no query, no fragment). Returns `false` otherwise.
 *
 * Real browsers never emit anything other than a canonical Origin, so this
 * tightening costs nothing in practice while ensuring we never echo a
 * malformed value into `Access-Control-Allow-Origin`.
 */
export function defaultLoopbackOriginResolver(
  requestOrigin: string | undefined,
): string | false {
  if (!requestOrigin) return false;
  if (requestOrigin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(requestOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  if (parsed.search || parsed.hash) return false;
  return LOOPBACK_HOSTS.has(parsed.hostname) ? requestOrigin : false;
}

/**
 * Resolve a `cors` config slot into either a fully-populated internal shape or
 * `null` (CORS disabled entirely). `undefined` produces the loopback default.
 */
export function resolveCorsOptions(
  input: false | HttpCorsOptions | undefined,
): ResolvedHttpCors | null {
  if (input === false) return null;
  if (input === undefined) {
    return {
      resolveOrigin: defaultLoopbackOriginResolver,
      isWildcard: false,
    };
  }

  const { origin } = input;
  if (origin === "*") {
    return { resolveOrigin: () => "*", isWildcard: true };
  }
  if (typeof origin === "string") {
    const allowed = origin;
    return {
      resolveOrigin: (requestOrigin) =>
        requestOrigin === allowed ? allowed : false,
      isWildcard: false,
    };
  }
  if (Array.isArray(origin)) {
    const allowed = new Set(origin);
    return {
      resolveOrigin: (requestOrigin) =>
        requestOrigin !== undefined && allowed.has(requestOrigin)
          ? requestOrigin
          : false,
      isWildcard: false,
    };
  }
  if (typeof origin === "function") {
    return { resolveOrigin: origin, isWildcard: false };
  }
  throw new TypeError(
    "cors.origin must be '*', a string, a string array, or a function",
  );
}

/**
 * Run the resolver in a try/catch so a misbehaving custom origin function
 * fails closed rather than crashing the in-flight request.
 */
function safeResolveOrigin(
  cors: ResolvedHttpCors,
  requestOrigin: string | undefined,
): string | false {
  try {
    return cors.resolveOrigin(requestOrigin);
  } catch {
    return false;
  }
}

/**
 * Build the response headers to add for a given request `Origin`.
 *
 * Returns an empty object when CORS is disabled (`cors === null`).
 *
 * When the policy is origin-dependent (non-wildcard), `Vary: Origin` is
 * **always** included -- including for rejected origins -- so a shared cache
 * keyed by the response cannot serve a no-CORS response back to a loopback
 * origin. Disallowed origins receive `{ Vary: "Origin" }` only, with no
 * `Access-Control-Allow-Origin`.
 *
 * The caller is responsible for applying these headers: spread the record
 * into the response headers, appending `Vary` when a prior value exists.
 *
 * @param cors Resolved CORS options, or `null` to short-circuit.
 * @param requestOrigin Value of the request's `Origin` header.
 * @param preflight `true` to include `Access-Control-Allow-Methods/Headers`.
 */
export function buildCorsHeaders(
  cors: ResolvedHttpCors | null,
  requestOrigin: string | undefined,
  preflight: boolean,
): Record<string, string> {
  if (!cors) return {};

  const headers: Record<string, string> = {};
  if (!cors.isWildcard) {
    headers["Vary"] = "Origin";
  }

  const allowed = safeResolveOrigin(cors, requestOrigin);
  if (allowed === false) return headers;

  headers["Access-Control-Allow-Origin"] = allowed;
  // Allow-Methods/Allow-Headers belong on preflight (204) only;
  // Expose-Headers belongs on the actual response only (browsers ignore it
  // on a preflight per the Fetch spec). Mirror that asymmetry here.
  if (preflight) {
    headers["Access-Control-Allow-Methods"] = ALLOW_METHODS;
    headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS;
    // Chrome Private Network Access: when a non-loopback Origin reaches a
    // loopback/private target (e.g. a hosted browser MCP client tunneled
    // to a local MCP server during integration testing), Chrome blocks the
    // preflight unless the server opts in via this header. The header is
    // ignored by other browsers and by Chrome when the cross-network
    // condition does not apply, so emitting it unconditionally on preflight
    // -- gated on the origin already being allowlisted by the policy --
    // is safe and avoids threading the request headers through the helper.
    // Spec: https://wicg.github.io/private-network-access/
    headers["Access-Control-Allow-Private-Network"] = "true";
  } else {
    headers["Access-Control-Expose-Headers"] = EXPOSE_HEADERS;
  }
  return headers;
}
