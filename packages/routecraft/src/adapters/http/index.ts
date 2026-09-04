import type { Enricher } from "../../operations/enrich.ts";
import type { Source } from "../../operations/from";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";
import { rejectStaleOptions } from "../../shared/stale-options.ts";
import { HttpEnricherAdapter } from "./enricher";
import { HttpSourceAdapter } from "./source";
import type {
  HttpClientOptions,
  HttpRequestBody,
  HttpResult,
  HttpServerOptions,
} from "./types";

/**
 * Discriminator for the overloaded factory: a source uses `path` while the
 * destination uses `url`. Internal helper kept private so callers always go
 * through the typed overloads.
 */
function isSourceOptions(
  options: HttpServerOptions | HttpClientOptions<unknown>,
): options is HttpServerOptions {
  return (
    typeof (options as HttpServerOptions).path === "string" &&
    (options as HttpClientOptions<unknown>).url === undefined
  );
}

/**
 * Create an HTTP source. Use with `.from(...)`. Requires `http: {...}` to be
 * configured on the context (typically via `defineConfig({ http: {...} })`)
 * so the plugin owns the port and the global auth check.
 *
 * @example
 * ```typescript
 * .from(http({ path: "/orders/:id", method: "GET" }))
 * .from(http({ path: "/health", method: "GET", auth: "skip" }))
 * ```
 *
 * @experimental
 */
export function http(options: HttpServerOptions): Source<HttpRequestBody>;
/**
 * Create an HTTP client enricher (a pull-in). Use with `.enrich()`, `.to()`
 * (the result replaces the body), or `.tap()` (fire-and-forget). Supports
 * dynamic url, headers, query, and body from the exchange.
 *
 * The client shape is selected by key presence (`url`), and the operation
 * keyword enforces the category: `.from(http({ url }))` fails to compile
 * because the client has no `subscribe`.
 *
 * @param options - method, url (string or (exchange) => string), optional headers, query, body, timeout, throwOnHttpError, maxBodySize, redirect
 * @returns An Enricher whose fetch returns { status, headers, body, url }
 *
 * @example
 * ```typescript
 * .to(http({ url: 'https://api.example.com/ingest', method: 'POST', body: (ex) => ex.body }))
 * .enrich(http({ url: (ex) => `https://api.example.com/users/${ex.body.userId}` }), only((r) => r.body, 'user'))
 * ```
 */
export function http<T = unknown, R = unknown>(
  options: HttpClientOptions<T>,
): Enricher<T, HttpResult<R>>;
export function http(
  options: HttpServerOptions | HttpClientOptions<unknown>,
): Source<HttpRequestBody> | Enricher<unknown, HttpResult<unknown>> {
  rejectStaleOptions(options, "http");
  if (isSourceOptions(options)) {
    const adapter = new HttpSourceAdapter(options);
    return tagAdapter(adapter, http, factoryArgs(options));
  }
  const adapter = new HttpEnricherAdapter<unknown, unknown>(options);
  return tagAdapter(adapter, http, factoryArgs(options));
}

// Re-export adapter classes and types for the public API surface.
export { isRedirect, HTTP_REDIRECT_STATUSES } from "./redirect";
export { HttpEnricherAdapter } from "./enricher";
export { HttpSourceAdapter } from "./source";
export type {
  HttpMethod,
  HttpRedirectMode,
  HttpResponder,
  HttpRespondContext,
  HttpRespondRequest,
  HttpResponseDescriptor,
  QueryParams,
  HttpClientOptions,
  HttpResult,
  HttpServerOptions,
  HttpPluginOptions,
  HttpRequestBody,
  HttpResponseHint,
  HttpAuth,
  HttpConfig,
  ApiKeyAuthOptions,
  HttpBuiltinsOptions,
  HttpBuiltinOptions,
  HttpOpenApiBuiltinOptions,
  HttpOpenApiInfo,
  HttpWebhookSignatureOptions,
  HttpWebhookSignatureScheme,
} from "./types";
