import { logger as defaultLogger } from "../../logger";
import { type ExchangeHeaders, HeadersKeys } from "../../exchange";
import type { Principal } from "../../auth/types";
import type { HttpMethod, HttpResponseHint } from "../../adapters/http/types";
import { missingCredentialReason, type HttpAuthMiddleware } from "./auth";
import type { HttpRouteEntry, HttpRouteRegistry } from "./registry";
import { parseRequestBody } from "./body-parser";

/** Function called once per completed dispatch when per-request events are enabled. */
export type RequestCompletedHandler = (event: {
  method: HttpMethod;
  path: string;
  status: number;
  durationMs: number;
  routeId?: string;
  principal?: Pick<Principal, "subject"> | undefined;
}) => void;

/** Synthetic handler for built-in endpoints (/health, /ready, /openapi.json). */
export type BuiltinHandler = (
  req: Request,
  pathname: string,
) => Response | Promise<Response> | null;

/**
 * Built-ins that require authentication before serving. The dispatcher checks
 * `paths` first (cheap, no commit to a response) and only invokes `handler`
 * after the auth middleware admits.
 */
export interface GatedBuiltins {
  paths: ReadonlySet<string>;
  handler: BuiltinHandler;
}

/**
 * Built-ins that always return a response (200) but vary the body based on
 * whether the request was authenticated. Used by `/ready` under
 * `details: "when-authenticated"`: anonymous callers get a minimal body,
 * authenticated callers get the full one. The endpoint never returns 401
 * so k8s readiness probes keep working without a credential.
 */
export interface AuthAwareBuiltins {
  paths: ReadonlySet<string>;
  handler: (
    req: Request,
    pathname: string,
    isAuthenticated: boolean,
  ) => Response | Promise<Response> | null;
}

export interface DispatcherOptions {
  registry: HttpRouteRegistry;
  authMiddleware: HttpAuthMiddleware | undefined;
  maxBodySize: number;
  builtins: BuiltinHandler;
  /** Optional gated built-ins (e.g. /openapi.json under `access: "authenticated"`). */
  gatedBuiltins?: GatedBuiltins;
  /** Optional auth-aware built-ins (e.g. /ready under `details: "when-authenticated"`). */
  authAwareBuiltins?: AuthAwareBuiltins;
  onRequestCompleted?: RequestCompletedHandler;
  /**
   * Called when the dispatcher itself synthesises a 401 because a route
   * with `auth: "required"` saw no credential. The plugin uses this to
   * emit `auth:rejected` for the missing-credential case (the middleware
   * cannot, because it returned `absent` rather than a Response). Reject
   * results returned by the middleware emit their own event via the
   * wrapper installed in `plugin.ts`.
   */
  onAuthAbsent?: (scheme: string) => void;
  /** Optional logger; defaults to the framework logger. */
  logger?: typeof defaultLogger;
}

/**
 * Build the Web-Fetch handler used by both the Bun and Node servers. The
 * dispatcher does not know which server it is talking to -- it only deals in
 * `Request` and `Response`. Pure-ish: state lives in the supplied `registry`,
 * which the plugin owns.
 */
export function createDispatcher(
  opts: DispatcherOptions,
): (req: Request) => Promise<Response> {
  const log = opts.logger ?? defaultLogger;

  return async function dispatch(req: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(req.url);
    const method = req.method.toUpperCase() as HttpMethod;
    const pathname = url.pathname;

    // 1. Match against the user registry first. Built-ins act as a default
    //    when no user route claims the path, so users can override /health
    //    et al by registering their own route.
    let methodMatch: {
      entry: HttpRouteEntry;
      params: Readonly<Record<string, string>>;
    } | null = null;
    const pathMatchMethods: HttpMethod[] = [];
    for (const entry of opts.registry.values()) {
      const params = entry.matcher.match(pathname);
      if (!params) continue;
      pathMatchMethods.push(entry.method);
      if (entry.method === method) {
        methodMatch = { entry, params };
        break;
      }
    }

    // 2. Built-ins answer when no user route matched. Three layers:
    //      a) Public: bypass auth and per-request events (probe-heavy
    //         deployments). Always-200.
    //      b) Auth-aware: run auth without forcing 401. The handler returns
    //         a richer response when admitted, a minimal one otherwise.
    //         Used by /ready under `details: "when-authenticated"` so
    //         readiness probes keep working without a credential.
    //      c) Gated: require admission, 401 otherwise. Used by
    //         /openapi.json under `access: "authenticated"`.
    if (!methodMatch && pathMatchMethods.length === 0) {
      const builtinRes = await opts.builtins(req, pathname);
      if (builtinRes) return builtinRes;

      if (opts.authAwareBuiltins?.paths.has(pathname)) {
        if (req.method !== "GET") {
          return new Response(null, {
            status: 405,
            headers: { Allow: "GET" },
          });
        }
        let isAuthenticated = false;
        if (opts.authMiddleware) {
          const result = await opts.authMiddleware(req);
          isAuthenticated = result.kind === "admit";
        }
        const authAwareRes = await opts.authAwareBuiltins.handler(
          req,
          pathname,
          isAuthenticated,
        );
        if (authAwareRes) return authAwareRes;
      }

      if (opts.gatedBuiltins?.paths.has(pathname)) {
        if (opts.authMiddleware) {
          const result = await opts.authMiddleware(req);
          // Built-ins never produce request:completed events regardless of
          // auth outcome; only emit for user-registered routes. Treat
          // `absent` like `reject`: gated built-ins are by definition
          // `openapi.access: "authenticated"`, so a missing credential is
          // a 401 just like a bad one. The plugin's wrapper emits
          // `auth:rejected` for `reject` directly; for `absent` we surface
          // it through the same `onAuthAbsent` hook the user-route path uses.
          if (result.kind === "reject") return result.response;
          if (result.kind === "absent") {
            opts.onAuthAbsent?.(result.scheme);
            return missingCredentialResponse(result.scheme);
          }
        }
        const gatedRes = await opts.gatedBuiltins.handler(req, pathname);
        if (gatedRes) return gatedRes;
      }
    }

    if (!methodMatch) {
      if (pathMatchMethods.length > 0) {
        const response = jsonResponse(
          { error: "method not allowed", allowed: pathMatchMethods },
          { status: 405, headers: { Allow: pathMatchMethods.join(", ") } },
        );
        emitCompleted(opts, {
          method,
          path: pathname,
          status: 405,
          durationMs: ms(started),
        });
        return response;
      }
      const response = jsonResponse(
        { error: "not found", path: pathname },
        { status: 404 },
      );
      emitCompleted(opts, {
        method,
        path: pathname,
        status: 404,
        durationMs: ms(started),
      });
      return response;
    }

    const { entry, params } = methodMatch;

    // 3. Auth check per the route's auth mode.
    //   - "skip"     : never call the middleware; no principal, no auth events.
    //   - "required" : call the middleware; absent or reject -> 401.
    //   - "optional" : call the middleware; admit attaches a principal,
    //                  reject still returns 401 (a presented credential that
    //                  fails verification is a hard error, not "anonymous"),
    //                  absent admits anonymously without emitting auth events.
    let principal: Principal | undefined;
    if (entry.authMode !== "skip" && opts.authMiddleware) {
      const result = await opts.authMiddleware(req);
      if (result.kind === "reject") {
        emitCompleted(opts, {
          method,
          path: entry.matcher.pattern,
          status: result.response.status,
          durationMs: ms(started),
          routeId: entry.routeId,
        });
        return result.response;
      }
      if (result.kind === "absent") {
        if (entry.authMode === "required") {
          opts.onAuthAbsent?.(result.scheme);
          const response = missingCredentialResponse(result.scheme);
          emitCompleted(opts, {
            method,
            path: entry.matcher.pattern,
            status: response.status,
            durationMs: ms(started),
            routeId: entry.routeId,
          });
          return response;
        }
        // optional + absent -> admit without a principal, no auth events.
      } else {
        principal = result.principal;
      }
    }

    // 4. Parse the body. Failures here are user-input errors (malformed JSON,
    //    body too large) -> 4xx; never 5xx.
    let parsedBody: unknown;
    try {
      const parsed = await parseRequestBody(req, {
        maxBodySize: opts.maxBodySize,
      });
      parsedBody = parsed.body;
    } catch (err) {
      const status = (err as { httpStatus?: number }).httpStatus ?? 400;
      const message =
        err instanceof Error ? err.message : "request body could not be parsed";
      const response = jsonResponse(
        { error: "bad request", message },
        { status },
      );
      emitCompleted(opts, {
        method,
        path: entry.matcher.pattern,
        status,
        durationMs: ms(started),
        routeId: entry.routeId,
      });
      return response;
    }

    // 5. Build the headers passed to the runtime handler. Standard request
    //    metadata uses dotted keys (path, method, url, headers) plus typed
    //    nested objects for params and query.
    const queryObject: Record<string, string> = {};
    for (const [k, v] of url.searchParams) queryObject[k] = v;
    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      reqHeaders[key] = value;
    });

    const handlerHeaders: ExchangeHeaders = {
      "routecraft.http.method": method,
      "routecraft.http.path": entry.matcher.pattern,
      "routecraft.http.url": req.url,
      "routecraft.http.params": params,
      "routecraft.http.query": Object.freeze(queryObject),
      "routecraft.http.headers": Object.freeze(reqHeaders),
      ...(principal !== undefined
        ? { [HeadersKeys.AUTH_PRINCIPAL]: principal }
        : {}),
    } as ExchangeHeaders;

    // 6. Run the route. The runtime hands us back the final exchange (post
    //    user steps and any registered .error() handler). We translate its
    //    body + response hints into a Response.
    try {
      const exchange = await entry.handler(parsedBody, handlerHeaders);
      const response = serialiseResponse(exchange.body, exchange.headers);
      emitCompleted(opts, {
        method,
        path: entry.matcher.pattern,
        status: response.status,
        durationMs: ms(started),
        routeId: entry.routeId,
        principal: principal ? { subject: principal.subject } : undefined,
      });
      return response;
    } catch (err) {
      log.error(
        { err, routeId: entry.routeId, method, path: pathname },
        "http source: route handler threw",
      );
      const response = jsonResponse(
        { error: "internal server error" },
        { status: 500 },
      );
      emitCompleted(opts, {
        method,
        path: entry.matcher.pattern,
        status: 500,
        durationMs: ms(started),
        routeId: entry.routeId,
      });
      return response;
    }
  };
}

function emitCompleted(
  opts: DispatcherOptions,
  event: Parameters<RequestCompletedHandler>[0],
): void {
  if (opts.onRequestCompleted) {
    try {
      opts.onRequestCompleted(event);
    } catch {
      // never let listener exceptions propagate into the request path
    }
  }
}

function ms(started: number): number {
  return Math.round(performance.now() - started);
}

function jsonResponse(
  payload: unknown,
  init: { status: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Build the canonical 401 for an `auth: "required"` route hit without a
 * credential. The auth middleware itself returns `kind: "absent"` so the
 * dispatcher can decide whether to issue a Response (required) or pass
 * through (optional); centralising the shape here keeps the dispatcher the
 * single source of truth for "missing credential" wire format. The reason
 * string is shared with the `auth:rejected` event emitted by the plugin so
 * the body and the event can never drift -- see `missingCredentialReason`.
 */
function missingCredentialResponse(scheme: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  // WWW-Authenticate per RFC 7235 only when the scheme is bearer. Sending
  // `Bearer` on an api-key route mis-signals the protocol.
  if (scheme === "bearer") {
    headers["www-authenticate"] = 'Bearer realm="routecraft"';
  }
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      reason: missingCredentialReason(scheme),
    }),
    { status: 401, headers },
  );
}

/**
 * Translate the final exchange body + response hint headers into a Response
 * according to the documented convention.
 */
function serialiseResponse(body: unknown, headers: ExchangeHeaders): Response {
  const hint = readResponseHint(headers);
  const extraHeaders = hint.headers ?? {};

  // Reject streaming bodies in v1 (SSE deferred).
  if (
    body !== null &&
    body !== undefined &&
    (isReadableStream(body) || isAsyncIterable(body))
  ) {
    return new Response(
      JSON.stringify({
        error: "streaming response bodies are not supported in v1",
        rc: "RC5018",
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...extraHeaders,
        },
      },
    );
  }

  // Null / undefined -> 204 unless the user explicitly overrode the status.
  if (body === null || body === undefined) {
    return new Response(null, {
      status: hint.status ?? 204,
      headers: extraHeaders,
    });
  }

  if (typeof body === "string") {
    return new Response(body, {
      status: hint.status ?? 200,
      headers: {
        "content-type": hint.contentType ?? "text/plain; charset=utf-8",
        ...extraHeaders,
      },
    });
  }

  if (body instanceof Uint8Array) {
    // Cast: TS picks the URLSearchParams overload of the BodyInit union for
    // Uint8Array under bun-types/node-types mixing. Uint8Array IS a valid
    // BodyInit (ArrayBufferView) at runtime.
    return new Response(body as unknown as BodyInit, {
      status: hint.status ?? 200,
      headers: {
        "content-type": hint.contentType ?? "application/octet-stream",
        ...extraHeaders,
      },
    });
  }

  if (body instanceof ArrayBuffer) {
    return new Response(body, {
      status: hint.status ?? 200,
      headers: {
        "content-type": hint.contentType ?? "application/octet-stream",
        ...extraHeaders,
      },
    });
  }

  // Object / array / number / boolean -> JSON.
  return new Response(JSON.stringify(body), {
    status: hint.status ?? 200,
    headers: {
      "content-type": hint.contentType ?? "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function readResponseHint(headers: ExchangeHeaders): HttpResponseHint {
  const status = headers["routecraft.http.response.status"];
  const contentType = headers["routecraft.http.response.contentType"];
  const responseHeaders = headers["routecraft.http.response.headers"];
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof contentType === "string" ? { contentType } : {}),
    ...(responseHeaders ? { headers: responseHeaders } : {}),
  };
}

function isReadableStream(value: unknown): value is ReadableStream {
  return (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}
