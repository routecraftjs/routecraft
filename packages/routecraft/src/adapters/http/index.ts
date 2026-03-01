import type { Destination } from "../../operations/to";
import { HttpDestinationAdapter } from "./destination";
import type { HttpOptions, HttpResult } from "./types";

/**
 * Creates an HTTP client destination. Use with `.to()`, `.enrich()`, or `.tap()`.
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
  options: HttpOptions<T>,
): Destination<T, HttpResult<R>> {
  return new HttpDestinationAdapter<T, R>(options);
}

// Re-export adapter class and types for public API
export { HttpDestinationAdapter } from "./destination";
export type { HttpMethod, QueryParams, HttpOptions, HttpResult } from "./types";
