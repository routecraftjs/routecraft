/**
 * CORS for the MCP HTTP transport.
 *
 * Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors,
 * web-hosted Claude Desktop) cannot read responses from the MCP HTTP transport
 * without CORS headers. This module owns the policy and the header math.
 *
 * The default is **loopback-only**: a request whose `Origin` is on `localhost`,
 * `127.0.0.1`, or `::1` (any port, http or https) gets reflected; everything
 * else gets no `Access-Control-Allow-Origin` header back and is blocked by the
 * browser. This is intentionally production-safe by construction: local
 * browser tooling works with zero config, while production deployments must
 * opt their real origins in explicitly. See `.standards/security.md` ->
 * "Security defaults policy" for the broader principle.
 *
 * Server-to-server callers (curl, `mcp-remote`, the MCP CLI) are unaffected by
 * CORS because they do not send an `Origin` header.
 *
 * The public option surface is intentionally minimal: only `origin` is
 * configurable. Method, header, expose-header, credentials, and preflight-cache
 * values are framework-controlled constants -- chosen to satisfy the RFC 9728
 * discovery contract and the MCP JSON-RPC handshake -- and can be expanded
 * later if a real use case demands it.
 */

import type { ServerResponse } from "node:http";

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
export type McpCorsOriginResolver = (
  requestOrigin: string | undefined,
) => string | false;

/**
 * CORS configuration for the MCP HTTP transport. Passed via
 * `mcpPlugin({ cors: { origin: ... } })`.
 *
 * Omitting `cors` entirely applies the loopback-only default. Pass
 * `cors: false` on `McpPluginOptions` to disable CORS handling completely
 * (useful when a reverse proxy or CDN owns CORS).
 */
export interface McpCorsOptions {
  /**
   * Allowed origin(s).
   *
   * - `"*"` -- permissive, no `Vary: Origin` emitted.
   * - `string` -- exact match against the request `Origin`; non-match returns no allow header.
   * - `string[]` -- allowlist; if the request `Origin` matches one entry, it is reflected.
   * - {@link McpCorsOriginResolver} -- custom resolver, returns the value to echo or `false` to disallow.
   */
  origin: "*" | string | string[] | McpCorsOriginResolver;
}

/**
 * Internal resolved CORS shape. The consumer never has to branch on string vs
 * array vs function form of `origin`. Not exported beyond this file.
 *
 * @internal
 */
interface ResolvedMcpCors {
  resolveOrigin: McpCorsOriginResolver;
  /** `true` when `origin` was the literal `"*"`. Skips `Vary: Origin`. */
  isWildcard: boolean;
}

/**
 * Framework-controlled CORS constants. Not user-configurable; chosen to
 * satisfy the RFC 9728 discovery contract and the MCP JSON-RPC handshake.
 *
 * - `Access-Control-Allow-Methods`: the verbs the transport accepts.
 * - `Access-Control-Allow-Headers`: `*` is the right default; `Authorization`,
 *   `Content-Type`, and `MCP-Protocol-Version` are the headers MCP clients
 *   send today, but the spec permits more and we do not want to gate.
 * - `Access-Control-Expose-Headers` (non-preflight only): the response headers
 *   browser clients must be able to read.
 *   - `WWW-Authenticate` -- RFC 9728 `resource_metadata` hint on a 401.
 *   - `Mcp-Session-Id` -- emitted by the SDK on `initialize` in stateful mode
 *     (see `server.ts` createSession). The MCP spec requires clients to echo
 *     this value on every subsequent request; browsers cannot read it
 *     cross-origin without it being exposed.
 *   - `Last-Event-ID` -- SSE resume cursor; required for browser-based SSE
 *     reconnection.
 *
 * @internal
 */
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS = "*";
const EXPOSE_HEADERS = "WWW-Authenticate, Mcp-Session-Id, Last-Event-ID";

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
 *
 * @internal
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
 *
 * @internal
 */
export function resolveCorsOptions(
  input: false | McpCorsOptions | undefined,
): ResolvedMcpCors | null {
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
    "mcpPlugin: cors.origin must be '*', a string, a string array, or a function",
  );
}

/**
 * Run the resolver in a try/catch so a misbehaving custom origin function
 * fails closed rather than crashing the in-flight MCP request.
 */
function safeResolveOrigin(
  cors: ResolvedMcpCors,
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
 * The caller is responsible for applying these headers. Use
 * {@link applyCorsHeaders} on a Node `ServerResponse` to merge `Vary` with
 * any existing value (compression middleware, etc.); spread the record into
 * a `writeHead` call when no prior `setHeader("Vary", ...)` is in play.
 *
 * @param cors Resolved CORS options, or `null` to short-circuit.
 * @param requestOrigin Value of the request's `Origin` header.
 * @param preflight `true` to include `Access-Control-Allow-Methods/Headers`.
 * @internal
 */
export function buildCorsHeaders(
  cors: ResolvedMcpCors | null,
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

/**
 * Apply CORS headers to a Node `ServerResponse`. Uses `setHeader` for the
 * `Access-Control-*` family and `appendHeader` for `Vary` so any existing
 * `Vary` value (e.g. `Vary: Accept-Encoding` from compression middleware)
 * is preserved.
 *
 * A no-op when `cors === null`.
 *
 * @internal
 */
export function applyCorsHeaders(
  res: ServerResponse,
  cors: ResolvedMcpCors | null,
  requestOrigin: string | undefined,
  preflight: boolean,
): void {
  if (!cors) return;
  const { Vary, ...rest } = buildCorsHeaders(cors, requestOrigin, preflight);
  for (const [name, value] of Object.entries(rest)) {
    res.setHeader(name, value);
  }
  if (Vary !== undefined) {
    res.appendHeader("Vary", Vary);
  }
}

/** Root path of the RFC 9728 protected-resource metadata document. */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

/**
 * Build the set of paths the MCP HTTP transport owns for CORS purposes, given
 * the resolved resource URL.
 *
 * The transport always listens on `/mcp` (and `/mcp/`). RFC 9728 §3 metadata
 * lives at the root path **and** at a path-suffixed variant derived from
 * `resource.url`'s pathname: e.g. for `resource.url = https://example.com/api/mcp`
 * the canonical client probe is `/.well-known/oauth-protected-resource/api/mcp`.
 * Both metadata URLs serve the identical document.
 *
 * The path-suffixed URL is derived dynamically because the MCP SDK's
 * `mcpAuthRouter` mounts its own path-aware doc at the same SDK-derived URL
 * (`/.well-known/oauth-protected-resource${rsPath}`); we must register our
 * handler at the same URL to shadow it and preserve the
 * "identical JSON regardless of auth mode" promise in
 * `.standards/security.md` §6.
 *
 * Returns the set of owned paths (always includes `/mcp`, `/mcp/`, and the
 * root metadata path; conditionally includes the path-suffixed metadata path).
 * The `metadataPaths` field is the subset on which the metadata document
 * is served.
 *
 * @internal
 */
export interface McpOwnedPaths {
  /** All paths the framework owns (CORS allowlist + OPTIONS short-circuit). */
  ownedPaths: ReadonlySet<string>;
  /** Subset of ownedPaths on which the RFC 9728 metadata doc is served. */
  metadataPaths: ReadonlySet<string>;
}

export function buildMcpOwnedPaths(resourceUrl: URL): McpOwnedPaths {
  const metadataPaths = new Set<string>([PROTECTED_RESOURCE_METADATA_PATH]);
  const rsPath = resourceUrl.pathname;
  if (rsPath && rsPath !== "/" && rsPath !== "") {
    metadataPaths.add(`${PROTECTED_RESOURCE_METADATA_PATH}${rsPath}`);
  }
  const ownedPaths = new Set<string>([...metadataPaths, "/mcp", "/mcp/"]);
  return { ownedPaths, metadataPaths };
}
