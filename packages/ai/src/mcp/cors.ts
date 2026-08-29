/**
 * CORS for the MCP HTTP transport, consumed from core.
 *
 * The policy engine, header math, and the RFC 9728 well-known path constant
 * live in `@routecraft/routecraft` (`plugins/server/cors.ts` and
 * `plugins/server/protected-resource.ts`), where every http surface shares
 * them. This module keeps the MCP-flavoured names this package has always
 * exported; behaviour is the shared implementation's, unchanged.
 *
 * Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors,
 * web-hosted Claude Desktop) cannot read responses from the MCP HTTP
 * transport without CORS headers. The default is loopback-only; see the core
 * module and `.standards/security.md` -> "Security defaults policy".
 */

import type {
  HttpCorsOptions,
  HttpCorsOriginResolver,
} from "@routecraft/routecraft";

export {
  buildCorsHeaders,
  defaultLoopbackOriginResolver,
  resolveCorsOptions,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "@routecraft/routecraft";

/**
 * Resolver form of `origin`. Receives the request's `Origin` header (or
 * `undefined` when absent) and returns either the value to echo in
 * `Access-Control-Allow-Origin`, or `false` to disallow. See the core
 * `HttpCorsOriginResolver` for the full contract.
 */
export type McpCorsOriginResolver = HttpCorsOriginResolver;

/**
 * CORS configuration for the MCP HTTP transport. Passed via
 * `mcpPlugin({ cors: { origin: ... } })`.
 *
 * Omitting `cors` entirely applies the loopback-only default. Pass
 * `cors: false` on `McpPluginOptions` to disable CORS handling completely
 * (useful when a reverse proxy or CDN owns CORS).
 */
export type McpCorsOptions = HttpCorsOptions;
