import type { Enricher } from "../../operations/enrich.ts";
import type { Exchange } from "../../exchange";
import { parseDuration } from "../../shared/duration.ts";
import { rcError } from "../../error";
import {
  declaredLengthOver,
  resolveMaxBodySize,
} from "../../plugins/http/max-body-size";
import type { StepSignalContext } from "../../types.ts";
import { isRedirect } from "./redirect";
import type {
  HttpClientOptions,
  HttpRedirectMode,
  HttpResult,
  QueryParams,
} from "./types";

const REDIRECT_MODES: ReadonlySet<string> = new Set<HttpRedirectMode>([
  "follow",
  "manual",
  "error",
]);

/**
 * HttpEnricherAdapter performs HTTP requests and returns the result: a pure
 * pull-in, so it implements the fetch role only.
 * - With `.enrich()`: the result replaces the body (or feeds the aggregator)
 * - With `.to()`: fetch-only fallback, the result replaces the body
 * - With `.tap()`: fire-and-forget, the result is discarded
 *
 * Two options bound what a remote endpoint can do to a route that calls it.
 * `maxBodySize` caps the response body, enforced against a declared
 * `Content-Length` before any byte is read and again against the running
 * count while the body streams, so the ceiling bounds what the process
 * spends rather than only what the route receives. `redirect` mirrors the
 * platform's three modes and takes no position on where a redirect leads:
 * with `"manual"` the 3xx comes back intact and the route decides.
 */
export class HttpEnricherAdapter<T = unknown, R = unknown> implements Enricher<
  T,
  HttpResult<R>
> {
  readonly adapterId = "routecraft.adapter.http";

  private readonly maxBodySize: number;
  private readonly redirect: HttpRedirectMode;

  constructor(private readonly options: HttpClientOptions<T>) {
    this.maxBodySize = resolveMaxBodySize(
      options.maxBodySize,
      "http() client",
      { allowUnbounded: true },
    );
    this.redirect = normalizeRedirect(options.redirect);
  }

  fetch = async (
    exchange: Exchange<T>,
    ctx: StepSignalContext = {},
  ): Promise<HttpResult<R>> => {
    const result = await this.performFetch(exchange, ctx.signal);
    return result as HttpResult<R>;
  };

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
      const parsed = parseInt(contentLength, 10);
      if (!isNaN(parsed)) {
        metadata["contentLength"] = parsed;
      }
    }

    return metadata;
  }

  private async performFetch(
    exchange: Exchange<T>,
    stepSignal?: AbortSignal,
  ): Promise<HttpResult> {
    const method = this.options.method ?? "GET";
    const url = this.resolveRequired(this.options.url, exchange);
    const headers = { ...(this.resolve(this.options.headers, exchange) ?? {}) };
    const query = this.resolve(this.options.query, exchange);
    const resolvedBody = this.resolve(this.options.body, exchange);
    const throwOnHttpError = this.options.throwOnHttpError ?? true;
    const timeoutMs =
      this.options.timeout === undefined
        ? undefined
        : parseDuration(this.options.timeout, "http({ timeout })");

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
    // Combine the adapter's own timeout controller with the step's
    // signal (an enclosing `.timeout()` deadline): whichever fires
    // first aborts the request.
    const signals = [controller?.signal, stepSignal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const signal =
      signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? undefined);

    try {
      const res = (await globalThis.fetch(finalUrl, {
        method,
        headers,
        body,
        redirect: this.redirect,
        signal,
      } as RequestInit)) as Response;

      const headersRecord: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersRecord[key] = value;
      });

      const bodyText = await this.readBody(res, headersRecord, finalUrl);

      const isRequestedRedirect =
        this.redirect === "manual" && isRedirect({ status: res.status });

      if (throwOnHttpError && !res.ok && !isRequestedRedirect) {
        throw new Error(`HTTP ${res.status}: ${bodyText}`);
      }

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

  /**
   * Read the response body as text without letting it exceed
   * `maxBodySize`.
   *
   * A declared `Content-Length` over the cap is refused first, without
   * reading a byte of the body: the cheapest refusal available. It is not
   * sufficient alone, because a chunked response declares nothing, so the
   * streaming arm counts what actually arrives and abandons the response the
   * moment the count crosses the ceiling. That second arm is what makes the
   * option bound what the process spends rather than only what the route
   * sees. Chunks are decoded as they arrive and never held together, so the
   * peak is the decoded text plus one chunk rather than several copies of
   * the body.
   *
   * Both refusing arms cancel the body first. An unconsumed response body
   * holds its connection checked out and keeps the runtime buffering
   * whatever the server sends, which is the exact cost the refusal exists to
   * avoid, and it leaks a socket per attempt on a route that polls.
   *
   * A response with no readable stream (a 204, a `HEAD`, or a test double
   * standing in for one) falls back to buffering, where the cap can only be
   * checked after the fact. Nothing is lost: a body that never streamed was
   * already in memory before this method was called.
   *
   * @throws RoutecraftError RC5061 when the declared or actual size exceeds
   * the cap.
   */
  private async readBody(
    res: Response,
    headersRecord: Record<string, string>,
    requestUrl: string,
  ): Promise<string> {
    const max = this.maxBodySize;

    const declared = declaredLengthOver(headersRecord["content-length"], max);
    if (declared !== undefined) {
      await res.body?.cancel().catch(() => {});
      throw this.tooLarge(res, requestUrl, declared, "declared");
    }

    const stream = res.body;
    if (!stream) {
      const text = await res.text();
      const size = new TextEncoder().encode(text).byteLength;
      if (size > max) {
        throw this.tooLarge(res, requestUrl, size, "read");
      }
      return text;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          throw this.tooLarge(res, requestUrl, total, "read");
        }
        // `stream: true` keeps a multi-byte character split across a chunk
        // boundary intact.
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text + decoder.decode();
  }

  /**
   * Build the `RC5061` refusal.
   *
   * Names the request URL, the status, the limit, and the size that was
   * either declared or counted, because the two arms know different things:
   * a declaration is what the server claimed, a count is what had arrived
   * before the read was abandoned and says nothing about what was still
   * coming. The status is in the message so an oversized error response
   * stays diagnosable as the HTTP failure it also is.
   */
  private tooLarge(
    res: Response,
    requestUrl: string,
    size: number,
    kind: "declared" | "read",
  ): Error {
    const seen =
      kind === "declared"
        ? `declares a body of ${size} bytes`
        : `had sent at least ${size} bytes when the read was abandoned`;
    return rcError("RC5061", undefined, {
      message: `http() client: ${requestUrl} (HTTP ${res.status}) ${seen}, over the maxBodySize of ${this.maxBodySize} bytes. Raise maxBodySize on this http({...}) call if the response is legitimately this large.`,
    });
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

/**
 * @throws RoutecraftError RC5003 when the mode is not one the platform
 * defines. Passing an unknown string to `fetch` is silently ignored by
 * some runtimes, which would leave a route believing it had opted out of
 * following redirects while the adapter kept following them.
 */
function normalizeRedirect(
  value: HttpRedirectMode | undefined,
): HttpRedirectMode {
  if (value === undefined) return "follow";
  if (!REDIRECT_MODES.has(value)) {
    throw rcError("RC5003", undefined, {
      message: `http() client: invalid redirect ${String(value)}. Allowed: ${[...REDIRECT_MODES].map((m) => `"${m}"`).join(", ")}.`,
    });
  }
  return value;
}
