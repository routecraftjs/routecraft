import type { Destination } from "../../operations/to";
import type { Source } from "../../operations/from";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";
import { HttpDestinationAdapter } from "./destination";
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
 * Create an HTTP client destination. Use with `.to()`, `.enrich()`, or `.tap()`.
 * Supports dynamic url, headers, query, and body from the exchange.
 *
 * @param options - method, url (string or (exchange) => string), optional headers, query, body, timeoutMs, throwOnHttpError
 * @returns A Destination that returns { status, headers, body, url }
 *
 * @example
 * ```typescript
 * .to(http({ url: 'https://api.example.com/ingest', method: 'POST', body: (ex) => ex.body }))
 * .enrich(http({ url: (ex) => `https://api.example.com/users/${ex.body.userId}` }))
 * ```
 */
export function http<T = unknown, R = unknown>(
  options: HttpClientOptions<T>,
): Destination<T, HttpResult<R>>;
export function http(
  options: HttpServerOptions | HttpClientOptions<unknown>,
): Source<HttpRequestBody> | Destination<unknown, HttpResult<unknown>> {
  if (isSourceOptions(options)) {
    const adapter = new HttpSourceAdapter(options);
    return tagAdapter(adapter, http, factoryArgs(options));
  }
  const adapter = new HttpDestinationAdapter<unknown, unknown>(options);
  return tagAdapter(adapter, http, factoryArgs(options));
}

// Re-export adapter classes and types for the public API surface.
export { HttpDestinationAdapter } from "./destination";
export { HttpSourceAdapter } from "./source";
export type {
  HttpMethod,
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
} from "./types";
