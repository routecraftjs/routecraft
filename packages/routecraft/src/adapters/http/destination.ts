import { type Destination } from "../../operations/to";
import { type Exchange } from "../../exchange";
import type { HttpOptions, HttpResult, QueryParams } from "./types";

/**
 * HttpDestinationAdapter performs HTTP requests and returns the result.
 * Can be used with both .to() and .enrich() operations.
 * - With .to(): result available via custom aggregator
 * - With .enrich(): result merged into body by default
 */
export class HttpDestinationAdapter<
  T = unknown,
  R = unknown,
> implements Destination<T, HttpResult<R>> {
  readonly adapterId = "routecraft.adapter.http";

  constructor(private readonly options: HttpOptions<T>) {}

  async send(exchange: Exchange<T>): Promise<HttpResult<R>> {
    const result = await this.performFetch(exchange);
    return result as HttpResult<R>;
  }

  /**
   * Extract metadata from HTTP result for observability.
   * Includes method, url, statusCode, and contentLength.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const httpResult = result as HttpResult<R>;
    const metadata: Record<string, unknown> = {
      method: this.options.method ?? "GET",
      url: httpResult.url,
      statusCode: httpResult.status,
    };

    // Add content length if available from headers
    const contentLength = httpResult.headers?.["content-length"];
    if (contentLength !== undefined) {
      metadata["contentLength"] = parseInt(contentLength, 10);
    }

    return metadata;
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
