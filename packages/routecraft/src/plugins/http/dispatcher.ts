import { jsonResponse, missingCredentialResponse } from "./response.ts";
import { anySignal } from "../../shared/abort.ts";
import { logger as defaultLogger } from "../../logger";
import { type ExchangeHeaders, HeadersKeys } from "../../exchange";
import { isRoutecraftError } from "../../brand";
import { isSuspended } from "../../suspension/suspended";
import { principalExpirySignal } from "../../auth/expiry.ts";
import type { Principal } from "../../auth/types";
import type { HttpMethod, HttpResponseHint } from "../../adapters/http/types";
import type { AuthResult } from "./auth";
import type { HttpRouteEntry, HttpRouteRegistry } from "./registry";
import {
  isSignatureRejection,
  parseRequestBody,
  type HttpBodyError,
} from "./body-parser";
import {
  isAsyncIterable,
  isReadableStream,
  SSE_CACHE_CONTROL,
  SSE_CONTENT_TYPE,
  streamResponseBody,
} from "./sse";
import type { HttpWebhookSignatureRejection } from "./webhook-signature";

/** Function called once per completed dispatch when per-request events are enabled. */
export type RequestCompletedHandler = (event: {
  method: HttpMethod;
  path: string;
  status: number;
  durationMs: number;
  routeId?: string;
  principal?: Pick<Principal, "subject"> | undefined;
  /** Set when a streaming body failed after its status line was sent. */
  error?: { name: string; message: string };
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
 * `requireAuth: true` on a walled mount: anonymous callers get a minimal
 * body, authenticated callers get the full one. The endpoint never returns
 * 401 so k8s readiness probes keep working without a credential.
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
  /**
   * The mount has an effective validator and did not opt out: every route
   * requires an admitted credential. When false, routes are served without
   * credentials ever being inspected, except entries flagged
   * `requiresPrincipal` (a route-entry `.authorize()`), which pull
   * verification individually.
   */
  walled: boolean;
  maxBodySize: number;
  builtins: BuiltinHandler;
  /** Optional gated built-ins (e.g. /openapi.json under `access: "authenticated"`). */
  gatedBuiltins?: GatedBuiltins;
  /** Optional auth-aware built-ins (/ready under `requireAuth: true`). */
  authAwareBuiltins?: AuthAwareBuiltins;
  onRequestCompleted?: RequestCompletedHandler;
  /**
   * Fires when the context begins stopping.
   *
   * A streaming response is in-flight work for as long as it runs, so
   * without this a graceful close waits out its whole grace window on a
   * stream that would happily have ended on request. Combined with the
   * client's own signal, so either end can close the stream.
   */
  shutdownSignal?: AbortSignal;
  /**
   * Called when the dispatcher itself synthesises a 401 because a route
   * with `auth: "required"` saw no credential. The plugin uses this to
   * emit `auth:rejected` for the missing-credential case: the shared
   * ingress only emits auth events when the `authenticate` thunk resolves
   * an admit or a reject, and `absent` is neither, so this hook is the one
   * place that case can still surface.
   */
  onAuthAbsent?: (scheme: string) => void;
  /**
   * Called when a route's webhook-signature gate rejects a request (RC5039
   * out of the body parser). The plugin uses this to emit `auth:rejected`
   * with `scheme: "signature"`, keeping signature failures on the same
   * observability surface as credential failures.
   */
  onSignatureRejected?: (reason: HttpWebhookSignatureRejection) => void;
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
): (
  req: Request,
  authenticate?: () => Promise<AuthResult | undefined>,
  claimStreamingSlot?: () => (() => void) | undefined,
) => Promise<Response> {
  const log = opts.logger ?? defaultLogger;

  return async function dispatch(
    req: Request,
    authenticate?: () => Promise<AuthResult | undefined>,
    claimStreamingSlot?: () => (() => void) | undefined,
  ): Promise<Response> {
    const started = performance.now();
    const url = new URL(req.url);
    const method = req.method.toUpperCase() as HttpMethod;
    const pathname = url.pathname;
    // The ingress-supplied thunk memoizes per request and emits the auth
    // events at its single resolution, so calling it from more than one
    // branch below never verifies twice.
    const resolveAuth = async (): Promise<AuthResult | undefined> =>
      authenticate?.();

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
    //         Used by /ready under `requireAuth: true` so readiness probes
    //         keep working without a credential.
    //      c) Gated: require admission, 401 otherwise. Used by
    //         /openapi.json under `requireAuth: true`.
    if (!methodMatch && pathMatchMethods.length === 0) {
      // Public built-ins (and plain 404s) bypass auth entirely: probes and
      // unmatched paths must never pay validator work or emit auth events.
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
        const result = await resolveAuth();
        isAuthenticated = result?.kind === "admit";
        const authAwareRes = await opts.authAwareBuiltins.handler(
          req,
          pathname,
          isAuthenticated,
        );
        if (authAwareRes) return authAwareRes;
      }

      if (opts.gatedBuiltins?.paths.has(pathname)) {
        const result = await resolveAuth();
        // Built-ins never produce request:completed events regardless of
        // auth outcome; only emit for user-registered routes. Treat
        // `absent` like `reject`: gated built-ins are by definition
        // `openapi.access: "authenticated"`, so a missing credential is
        // a 401 just like a bad one. The ingress emits `auth:rejected` for
        // `reject` at resolution; `absent` surfaces through the same
        // `onAuthAbsent` hook the user-route path uses.
        if (result?.kind === "reject") return result.response;
        if (result?.kind === "absent") {
          safeNotify(() => opts.onAuthAbsent?.(result.scheme));
          return missingCredentialResponse(result.scheme);
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

    // 3. Admission per the mount posture. The mount is the wall: `walled`
    //    demands an admitted credential for every route. On a public mount
    //    (`walled: false`) credentials are never inspected, except for a
    //    route that declares `.authorize()` (`requiresPrincipal`), which
    //    can only make itself stricter, never looser.
    let principal: Principal | undefined;
    if (opts.walled || entry.requiresPrincipal) {
      const result = await resolveAuth();
      if (!result) {
        // No validator anywhere. Unreachable for `walled` (a wall implies
        // a validator) and for `requiresPrincipal` (refused at bind); kept
        // as a served fallthrough so a future gap fails open loudly in
        // authorize() (RC5012) rather than silently 500ing here.
      } else if (result.kind === "reject") {
        emitCompleted(opts, {
          method,
          path: entry.matcher.pattern,
          status: result.response.status,
          durationMs: ms(started),
          routeId: entry.routeId,
        });
        return result.response;
      } else if (result.kind === "absent") {
        safeNotify(() => opts.onAuthAbsent?.(result.scheme));
        const response = missingCredentialResponse(result.scheme);
        emitCompleted(opts, {
          method,
          path: entry.matcher.pattern,
          status: response.status,
          durationMs: ms(started),
          routeId: entry.routeId,
        });
        return response;
      } else {
        principal = result.principal;
      }
    }

    // 4. Parse the body. Failures here are user-input errors (malformed JSON,
    //    body too large, failed signature) -> 4xx; never 5xx. The signature
    //    gate runs inside parseRequestBody, after the maxBodySize checks and
    //    before content-type parsing.
    let parsedBody: unknown;
    let rawBytes: Uint8Array | undefined;
    try {
      const parsed = await parseRequestBody(req, {
        maxBodySize: opts.maxBodySize,
        ...(entry.signature !== undefined
          ? { signature: entry.signature }
          : {}),
        ...(entry.rawBody ? { rawBody: true } : {}),
      });
      parsedBody = parsed.body;
      // Only retain the wire buffer when the route asked for it; holding it
      // unconditionally would pin up to maxBodySize per in-flight request on
      // routes that never opted in.
      rawBytes = entry.rawBody ? parsed.rawBytes : undefined;
    } catch (err) {
      if (isSignatureRejection(err)) {
        // Signature rejections use the same wire shape as the other 401s
        // (missing/invalid credential). No WWW-Authenticate: the mechanism
        // is not an RFC 7235 challenge scheme, matching the apiKey
        // precedent. The bounded reason rides the typed field on the error,
        // never err.message (see .standards/security.md section 10).
        safeNotify(() => opts.onSignatureRejected?.(err.signatureRejection));
        const response = jsonResponse(
          { error: "unauthorized", reason: err.signatureRejection },
          { status: err.httpStatus },
        );
        emitCompleted(opts, {
          method,
          path: entry.matcher.pattern,
          status: err.httpStatus,
          durationMs: ms(started),
          routeId: entry.routeId,
        });
        return response;
      }
      const status = isRoutecraftError(err)
        ? ((err as HttpBodyError).httpStatus ?? 400)
        : 400;
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

    // 5. Build the headers passed to the runtime handler. The parsed request
    //    envelope (method, path, url) is promoted to its own dotted keys, with
    //    typed nested maps for params and query; the open-ended pass-through
    //    wire headers go into the single `routecraft.http.rawHeaders` map.
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
      "routecraft.http.rawHeaders": Object.freeze(reqHeaders),
      ...(entry.rawBody && rawBytes !== undefined
        ? { "routecraft.http.rawBody": rawBytes }
        : {}),
      ...(principal !== undefined
        ? { [HeadersKeys.AUTH_PRINCIPAL]: principal }
        : {}),
    } as ExchangeHeaders;

    // 6. Run the route. The runtime hands us back the final exchange (post
    //    user steps and any registered .error() handler). We translate its
    //    body + response hints into a Response.
    try {
      const exchange = await entry.handler(parsedBody, handlerHeaders);
      const plan = planStream(exchange.body, exchange.headers);
      if (plan) {
        // A stream may stay quiet far longer than the listener's idle
        // reaper allows, and the mount cannot know at bind time which of
        // its routes will stream, so the slot is claimed here, for this
        // request, once the body proves to be one. A listener already at
        // its cap refuses rather than opening a stream it cannot bound.
        const release = claimStreamingSlot?.();
        if (claimStreamingSlot !== undefined && release === undefined) {
          const response = jsonResponse(
            { error: "service unavailable", reason: "streaming_capacity" },
            { status: 503, headers: { "retry-after": "5" } },
          );
          emitCompleted(opts, {
            method,
            path: entry.matcher.pattern,
            status: 503,
            durationMs: ms(started),
            routeId: entry.routeId,
          });
          return response;
        }
        // A stream admitted on a credential that expires mid-flight would
        // otherwise keep serving on authority that has lapsed, and this is
        // the first surface where one admission check covers an unbounded
        // window. Closing is the whole remedy: a 401 cannot follow a 200, and
        // an SSE client reconnects by specification, so the reconnect goes
        // through ordinary admission and gets its 401 from the path that
        // already exists. A principal with no `expiresAt` is left alone,
        // because a credential with no expiry granting an unexpiring stream
        // is the operator's choice honoured rather than a gap.
        const expiry = principalExpirySignal(principal, ({ subject }) => {
          log.info(
            { subject, routeId: entry.routeId, path: pathname },
            "http source: closing stream, the admitted credential has expired",
          );
        });
        const body = streamResponseBody(plan.body, {
          signal: anySignal(req.signal, opts.shutdownSignal, expiry?.signal),
          preamble: plan.preamble,
          onCleanupError: (error) => {
            log.error(
              { err: error, routeId: entry.routeId, method, path: pathname },
              "http source: streaming route failed to clean up after the response ended",
            );
          },
          onEnd: (error) => {
            release?.();
            expiry?.cancel();
            if (error !== undefined) {
              log.error(
                { err: error, routeId: entry.routeId, method, path: pathname },
                "http source: streaming response body failed after the status line was sent",
              );
            }
            emitCompleted(opts, {
              method,
              path: entry.matcher.pattern,
              status: plan.status,
              durationMs: ms(started),
              routeId: entry.routeId,
              principal: principal ? { subject: principal.subject } : undefined,
              ...(error !== undefined
                ? {
                    error: {
                      name: error instanceof Error ? error.name : "Error",
                      message:
                        error instanceof Error ? error.message : String(error),
                    },
                  }
                : {}),
            });
          },
        });
        return new Response(body, {
          status: plan.status,
          headers: plan.headers,
        });
      }
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

/**
 * Run a user-facing listener without letting its exceptions reach the
 * request path, mirroring the guard emitCompleted applies to its handler.
 */
function safeNotify(fn: () => void): void {
  try {
    fn();
  } catch {
    // never let listener exceptions propagate into the request path
  }
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

/** A streaming body, with the status and headers its response carries. */
interface StreamPlan {
  body: AsyncIterable<unknown> | ReadableStream<Uint8Array>;
  status: number;
  headers: Record<string, string>;
  /** The response is an event stream, so it opens with the SSE comment. */
  preamble: boolean;
}

/**
 * Recognise a streaming body and decide the response it heads.
 *
 * Two arms, split on what the route handed back rather than on any option.
 * An `AsyncIterable` is framed as Server-Sent Events, because that is the
 * only thing a sequence of yielded values can mean over HTTP without the
 * route saying more. A `ReadableStream` is already bytes and is passed
 * through untouched, so a route that has its own wire format reaches for
 * that one.
 *
 * Overrides win over both defaults, which is how a caller chooses
 * `application/x-ndjson`. Framing follows the body type, not the content
 * type: an iterable of objects is SSE-framed whatever the header says, and
 * a route wanting different bytes yields strings.
 */
function planStream(
  body: unknown,
  headers: ExchangeHeaders,
): StreamPlan | undefined {
  if (body === null || body === undefined) return undefined;
  const raw = isReadableStream(body);
  if (!raw && !isAsyncIterable(body)) return undefined;

  const hint = readResponseHint(headers);
  const extraHeaders = lowerCaseKeys(hint.headers);
  const responseHeaders = raw
    ? {
        "content-type": hint.contentType ?? "application/octet-stream",
        ...extraHeaders,
      }
    : {
        "content-type": hint.contentType ?? SSE_CONTENT_TYPE,
        "cache-control": SSE_CACHE_CONTROL,
        ...extraHeaders,
      };
  return {
    body: body as AsyncIterable<unknown> | ReadableStream<Uint8Array>,
    status: hint.status ?? 200,
    headers: responseHeaders,
    // Conditioned on the content type rather than on the body type, because
    // the comment is only legal in an event stream. A route that named a
    // different format owns its bytes from the first one.
    preamble:
      responseHeaders["content-type"]?.startsWith("text/event-stream") === true,
  };
}

/**
 * Lower-case a header override's keys so the spread that follows genuinely
 * overrides.
 *
 * HTTP header names are case-insensitive and object keys are not, so a route
 * spelling an override `Content-Type` used to add a second key beside the
 * framework's own `content-type`. `Headers` then joined the two values into
 * one nonsensical field, and the streaming arm additionally read the wrong
 * one when deciding whether to open with the SSE comment, prepending bytes
 * to a body the route had declared as something else.
 */
function lowerCaseKeys(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/**
 * Translate the final exchange body + response hint headers into a Response
 * according to the documented convention.
 */
function serialiseResponse(body: unknown, headers: ExchangeHeaders): Response {
  const hint = readResponseHint(headers);
  // Same normalisation as the streaming arm: a differently-cased override
  // otherwise duplicates the header rather than replacing it.
  const extraHeaders = lowerCaseKeys(hint.headers);

  // A parked exchange answers 202 with the acknowledgment as its body. HTTP
  // is the one transport with an out-of-band status channel, so the status
  // carries the `Output | Suspended` discrimination and the declared 200
  // body type stays the route's own output. `Retry-After` is the TTL, which
  // is the honest hint: after it, the suspension is no longer resumable. An
  // explicit `.header("routecraft.http.response.status", ...)` still wins,
  // because a route that overrode the status meant it.
  if (isSuspended(body)) {
    const retryAfter = retryAfterSeconds(body.expiresAt);
    return new Response(JSON.stringify(body), {
      status: hint.status ?? 202,
      headers: {
        "content-type": hint.contentType ?? "application/json; charset=utf-8",
        ...(retryAfter !== undefined
          ? { "retry-after": String(retryAfter) }
          : {}),
        ...extraHeaders,
      },
    });
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

/**
 * Whole seconds until `expiresAt`, for `Retry-After`.
 *
 * Absent when the suspension has no TTL (nothing honest to promise) or the
 * deadline has already passed (a `Retry-After: 0` would invite an immediate
 * retry against a suspension that can no longer be resumed).
 */
function retryAfterSeconds(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined) return undefined;
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
  return Math.ceil(remaining / 1000);
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
