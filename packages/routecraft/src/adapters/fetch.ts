import { type Destination } from "../operations/to.ts";
import { type Enricher } from "../operations/enrich.ts";
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

export interface FetchOptions<T = unknown> {
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

export type FetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string | unknown;
  url: string;
};

/**
 * FetchAdapter can act as a Processor, Enricher, or Destination.
 * - process: replaces body with FetchResult
 * - enrich: returns FetchResult for aggregation
 * - send: performs request as side effect (ignores body)
 */
export class FetchAdapter<T = unknown, R = FetchResult>
  implements Enricher<T, R>, Destination<T>
{
  readonly adapterId = "routecraft.adapter.fetch";

  constructor(private readonly options: FetchOptions<T>) {}

  async enrich(exchange: Exchange<T>): Promise<R> {
    const result = await this.performFetch(exchange);
    return result as unknown as R;
  }

  async send(exchange: Exchange<T>): Promise<void> {
    await this.performFetch(exchange);
  }

  private async performFetch(exchange: Exchange<T>): Promise<FetchResult> {
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
      } satisfies FetchResult;
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
