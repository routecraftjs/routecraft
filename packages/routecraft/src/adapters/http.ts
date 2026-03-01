import { type Destination } from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type QueryParams = Record<string, string | number | boolean>;

export interface HttpOptions<T = unknown> {
  method?: HttpMethod;
  url: string | ((exchange: Exchange<T>) => string);
  headers?:
    | Record<string, string>
    | ((exchange: Exchange<T>) => Record<string, string>);
  query?: QueryParams | ((exchange: Exchange<T>) => QueryParams);
  body?: unknown | ((exchange: Exchange<T>) => unknown);
  timeoutMs?: number;
  throwOnHttpError?: boolean;
}

export type HttpResult<T = string | unknown> = {
  status: number;
  headers: Record<string, string>;
  body: T;
  url: string;
};

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
): HttpAdapter<T, R> {
  return new HttpAdapter<T, R>(options);
}

/**
 * HttpAdapter performs HTTP requests and returns the result.
 * Can be used with both .to() and .enrich() operations.
 * - With .to(): result available via custom aggregator
 * - With .enrich(): result merged into body by default
 */
export class HttpAdapter<T = unknown, R = unknown> implements Destination<
  T,
  HttpResult<R>
> {
  readonly adapterId = "routecraft.adapter.http";

  constructor(private readonly options: HttpOptions<T>) {}

  async send(exchange: Exchange<T>): Promise<HttpResult<R>> {
    const result = await this.performFetch(exchange);
    return result as HttpResult<R>;
  }

  private async performFetch(exchange: Exchange<T>): Promise<HttpResult> {
    const method = this.options.method ?? "GET";
    const url = this.resolveRequired(this.options.url, exchange);
    const headers = { ...(this.resolve(this.options.headers, exchange) ?? {}) };
    const query = this.resolve(this.options.query, exchange);
    const resolvedBody = this.resolve(this.options.body, exchange);
    const throwOnHttpError = this.options.throwOnHttpError ?? true;
    const timeoutMs = this.options.timeoutMs ?? undefined;

    const finalUrl = this.appendQuery(url, query ?? {});

    let body: BodyInit | undefined;
    if (resolvedBody !== undefined && resolvedBody !== null) {
      if (
        typeof resolvedBody === "string" ||
        resolvedBody instanceof Uint8Array ||
        resolvedBody instanceof ArrayBuffer
      ) {
        body = resolvedBody as BodyInit;
      } else {
        if (!headers["Content-Type"])
          headers["Content-Type"] = "application/json";
        body = JSON.stringify(resolvedBody);
      }
    }

    const controller = timeoutMs ? new AbortController() : undefined;
    const timeout = timeoutMs
      ? setTimeout(() => controller!.abort(), timeoutMs)
      : undefined;

    try {
      const res = (await globalThis.fetch(finalUrl, {
        method,
        headers,
        body,
        signal: controller?.signal,
      } as RequestInit)) as Response;

      if (throwOnHttpError && !res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const headersRecord: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersRecord[key] = value;
      });

      const bodyText = await res.text();

      // Auto-parse JSON based on Content-Type
      let parsedBody: string | unknown = bodyText;
      const contentType = headersRecord["content-type"]?.toLowerCase() || "";
      if (contentType.includes("application/json")) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // Parse failed, keep as string
          parsedBody = bodyText;
        }
      }

      return {
        status: res.status,
        headers: headersRecord,
        body: parsedBody,
        url: res.url || finalUrl,
      } satisfies HttpResult;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private resolve<V>(
    val: V | ((exchange: Exchange<T>) => V) | undefined,
    exchange: Exchange<T>,
  ): V | undefined {
    if (typeof val === "function") {
      return (val as (e: Exchange<T>) => V)(exchange);
    }
    return val as V | undefined;
  }

  private resolveRequired<V>(
    val: V | ((exchange: Exchange<T>) => V),
    exchange: Exchange<T>,
  ): V {
    if (typeof val === "function") {
      return (val as (e: Exchange<T>) => V)(exchange);
    }
    return val as V;
  }

  private appendQuery(url: string, query?: QueryParams): string {
    if (!query || Object.keys(query).length === 0) return url;
    const u = new URL(url, this.base(url));
    for (const [k, v] of Object.entries(query)) {
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private base(url: string): string | undefined {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return undefined;
    }
  }
}
