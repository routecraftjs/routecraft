/**
 * The management API's HTTP door.
 *
 * The only file in this surface that knows HTTP exists: it turns a request
 * into a call on {@link ManagementApi} and that call's result into a
 * response. Resource-shaped, because dispatching creates an exchange and
 * the exchange is a sub-resource of the route it runs on, which also gives
 * the operations tier somewhere obvious to land later without inventing a
 * second grammar.
 *
 * The shape of the door is not a licence to move logic through it: every
 * decision about what a route IS lives in `management.ts`, and every
 * decision about who may act lives in `tier.ts`.
 */

import { isRoutecraftError, rcCodeOf } from "../../brand";
import { missingCredentialReason } from "../http/auth";
import {
  jsonResponse,
  methodNotAllowed,
  missingCredentialResponse,
} from "../http/response";
import { safeStringify } from "../../shared/safe-json.ts";
import { sseResponse, type SseEvent } from "../http/sse";
import type { HttpMountContext } from "../server/types";
import type { ManagementApi } from "./management";
import { admitToTier, type TierVerdict } from "./tier";
import type { OpsEventTailItem, OpsRouteQuery, OpsTiers } from "./types";

export interface ManagementHandlerOptions {
  api: ManagementApi;
  /** Resolved tier values. Unset tiers are disabled. */
  tiers: OpsTiers;
  /**
   * Report a refusal this mount made itself.
   *
   * The ingress emits `auth:success` and `auth:rejected` around the validator,
   * which covers a credential that failed verification. It cannot cover the
   * two refusals decided here: a credential-free caller on a scope-gated tier
   * (the validator answers `absent`, which is neither), and a caller the
   * validator admitted whose principal lacks the scope. Without this, an
   * operator counting rejections to spot probing of the management surface
   * sees nothing for either, and sees `auth:success` for someone who was then
   * refused. The http plugin wires the same parity hook for its own `absent`
   * case.
   */
  onRefused?: (refusal: { reason: string; scheme: string }) => void;
}

/** `GET /ops/routes` and `GET /ops/routes/{id}`. */
const ROUTES_COLLECTION = "/ops/routes";
const ROUTE_DETAIL = /^\/ops\/routes\/([^/]+)$/;
const ROUTE_EXCHANGES = /^\/ops\/routes\/([^/]+)\/exchanges$/;
/** `GET /ops/events`. */
const EVENTS = "/ops/events";

/**
 * Percent-decode a path segment, or `undefined` when the escape is
 * malformed. `decodeURIComponent` throws on input like `%` or `%zz`, which
 * any caller can send; funnelling those into the same 404 as an unknown
 * route keeps a malformed id from reading as a server fault.
 */
function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

const notFound = (): Response =>
  jsonResponse({ error: "not found" }, { status: 404 });

/**
 * Turn a refusal into its wire form.
 *
 * A disabled tier answers 404 rather than 403 so an instance discloses
 * nothing about what it could expose, and so the rule is the one an ingress
 * proxy would enforce in front of it. A missing scope is 403 with the
 * RFC 6750 `insufficient_scope` shape, which is what tells a client the
 * identity was fine and the credential was not.
 */
function refuse(
  verdict: Exclude<TierVerdict, { kind: "admit" }>,
  onRefused: ManagementHandlerOptions["onRefused"],
): Response {
  // A disabled tier is not an auth decision: it answers 404 to everyone, so
  // reporting it as a rejection would count configuration as probing.
  if (verdict.kind === "disabled") return notFound();
  // The ingress already emitted for a verified-and-rejected credential.
  if (verdict.kind === "rejected") return verdict.response;
  if (verdict.kind === "unauthenticated") {
    onRefused?.({
      reason: missingCredentialReason(verdict.scheme),
      scheme: verdict.scheme,
    });
    return missingCredentialResponse(verdict.scheme);
  }
  onRefused?.({ reason: "insufficient_scope", scheme: verdict.scheme });
  // Bearer-only challenge: announcing `Bearer` to an api-key client points it
  // at a ceremony it cannot perform (same rule as missingCredentialResponse).
  const headers =
    verdict.scheme === "bearer"
      ? {
          "www-authenticate": `Bearer realm="routecraft", error="insufficient_scope", scope="${verdict.missing}"`,
        }
      : undefined;
  return jsonResponse(
    {
      error: "forbidden",
      reason: "insufficient_scope",
      scope: verdict.missing,
    },
    { status: 403, ...(headers !== undefined ? { headers } : {}) },
  );
}

/** Parse `?dispatchable=`, refusing a value that is neither true nor false. */
function readBoolean(raw: string | null): boolean | undefined | "invalid" {
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "invalid";
}

/** Parse `?limit=`, leaving range validation to the pagination module. */
function readLimit(raw: string | null): number | undefined | "invalid" {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return "invalid";
  return value;
}

/**
 * Build the `/ops` request handler.
 *
 * Returns `undefined` for any path it does not own, so the ops mount can
 * offer the request to its health surface instead of the two competing over
 * one routing table.
 */
export function createManagementHandler(
  options: ManagementHandlerOptions,
): (req: Request, context: HttpMountContext) => Promise<Response | undefined> {
  const { api, tiers, onRefused } = options;

  return async function handle(
    req: Request,
    context: HttpMountContext,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (!pathname.startsWith("/ops/")) {
      return undefined;
    }

    const detailMatch = ROUTE_DETAIL.exec(pathname);
    const exchangesMatch = ROUTE_EXCHANGES.exec(pathname);

    if (pathname === ROUTES_COLLECTION || detailMatch) {
      const verdict = await admitToTier(tiers.introspection, context);
      if (verdict.kind !== "admit") return refuse(verdict, onRefused);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      return pathname === ROUTES_COLLECTION
        ? listRoutes(api, url)
        : describeRoute(api, detailMatch![1]!);
    }

    if (pathname === EVENTS) {
      const verdict = await admitToTier(tiers.events, context);
      if (verdict.kind !== "admit") return refuse(verdict, onRefused);
      if (req.method !== "GET") {
        return methodNotAllowed("GET");
      }
      // A tail may say nothing for hours, which is exactly what the
      // listener's idle reaper exists to cut. The rest of this mount is
      // ordinary request/response, so the exemption is claimed for this
      // request rather than declared for the whole surface.
      context.exemptFromIdleTimeout();
      return sseResponse(tailEvents(api, req.signal), req.signal);
    }

    if (exchangesMatch) {
      const verdict = await admitToTier(tiers.dispatch, context);
      if (verdict.kind !== "admit") return refuse(verdict, onRefused);
      if (req.method !== "POST") {
        return methodNotAllowed("POST");
      }
      return dispatchExchange(api, exchangesMatch[1]!, req, verdict.principal);
    }

    return notFound();
  };
}

function listRoutes(api: ManagementApi, url: URL): Response {
  const dispatchable = readBoolean(url.searchParams.get("dispatchable"));
  if (dispatchable === "invalid") {
    return badRequest('The "dispatchable" filter must be "true" or "false".');
  }
  const limit = readLimit(url.searchParams.get("limit"));
  if (limit === "invalid") {
    return badRequest("The page limit must be a positive integer.");
  }
  const id = url.searchParams.get("id");
  const source = url.searchParams.get("source");
  const after = url.searchParams.get("after");

  const query: OpsRouteQuery = {
    ...(dispatchable !== undefined ? { dispatchable } : {}),
    ...(id !== null ? { id } : {}),
    ...(source !== null ? { source } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== null ? { after } : {}),
  };

  try {
    return jsonResponse(api.listRoutes(query), { status: 200 });
  } catch (error: unknown) {
    // A malformed limit or cursor is the caller's, and its message names
    // the way out; anything else is ours and must not be echoed.
    if (rcCodeOf(error) === "RC5059") {
      return badRequest((error as Error).message);
    }
    throw error;
  }
}

function describeRoute(api: ManagementApi, rawId: string): Response {
  const id = decodeSegment(rawId);
  if (id === undefined) return notFound();
  const route = api.describeRoute(id);
  return route === undefined
    ? notFound()
    : jsonResponse(route, { status: 200 });
}

async function dispatchExchange(
  api: ManagementApi,
  rawId: string,
  req: Request,
  principal: Parameters<ManagementApi["dispatch"]>[2],
): Promise<Response> {
  const id = decodeSegment(rawId);
  if (id === undefined) return notFound();

  let body: unknown;
  try {
    const text = await req.text();
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    return badRequest("The request body must be JSON.");
  }

  try {
    const outcome = await api.dispatch(id, body, principal);
    if (outcome.outcome === "suspended") {
      // 202 for a park, the same answer the http() source gives: the work
      // was accepted and is not finished, and the acknowledgment carries
      // what is needed to finish it.
      return jsonResponse(outcome, { status: 202 });
    }
    // A drop is a terminal outcome the request delivered successfully, so
    // it is 200 with the outcome named rather than an error status: the
    // caller asked for a dispatch and got a complete answer about one.
    return jsonResponse(outcome, { status: 200 });
  } catch (error: unknown) {
    if (!isRoutecraftError(error)) throw error;
    const code = rcCodeOf(error);
    if (code === "RC5004") return notFound();
    if (code === "RC5060") {
      return jsonResponse(
        {
          error: "not dispatchable",
          code,
          message: (error as Error).message,
        },
        { status: 409 },
      );
    }
    // The code crosses the wire and the message does not. A route failure is
    // whatever its steps threw, and `rcError` messages routinely interpolate
    // the cause: adapter failures carry hostnames, file paths and upstream
    // response text. On an open dispatch tier that is reconnaissance for
    // anyone who can reach the port, and it would contradict the health
    // surface's rule that no response body carries an error message. That
    // rule governs dispatch and health; the event tail is a separately
    // scope-gated observation surface and does carry messages, on purpose,
    // because a failure event without one is not diagnostic. The code
    // is enough to tell an authorize refusal from a broken step; the message
    // is in the logs, where the error policy already routes it.
    return jsonResponse({ error: "dispatch failed", code }, { status: 500 });
  }
}

function badRequest(message: string): Response {
  return jsonResponse({ error: "bad request", message }, { status: 400 });
}

/**
 * Map the tail's items onto the wire.
 *
 * The bus event name rides the SSE `event` field so a client can subscribe
 * to one kind, and repeats inside `data` because a reader consuming the
 * body with `fetch` rather than `EventSource` sees the payload and not the
 * fields. The tail's own signals are not bus events and do not borrow a
 * bus name: a drop is named for what it is, and a heartbeat is the spec's
 * comment, which every client already ignores.
 */
async function* tailEvents(
  api: ManagementApi,
  signal: AbortSignal,
): AsyncIterable<SseEvent | string> {
  for await (const item of api.tailEvents(signal)) {
    yield frameOf(item);
  }
}

function frameOf(item: OpsEventTailItem): SseEvent | string {
  if (item.kind === "heartbeat") return ": keep-alive\n\n";
  if (item.kind === "dropped") {
    return { event: "ops:events:dropped", data: { count: item.count } };
  }
  return {
    event: item.name,
    // Pre-serialised rather than handed over as an object, because a bus
    // payload is not JSON: it carries errors, and exchanges and routes that
    // cycle. `_snapshot` sub-payloads go with it. They exist so a surface
    // that was not asked to capture payloads does not, and a tail an
    // operator opened is not that asking.
    data: safeStringify(
      {
        event: item.name,
        ts: item.ts,
        contextId: item.contextId,
        details: item.details,
      },
      { dropSnapshot: true },
    ),
  };
}
