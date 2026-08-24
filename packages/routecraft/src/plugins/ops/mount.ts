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

import { isRoutecraftError } from "../../brand";
import { jsonResponse, missingCredentialResponse } from "../http/response";
import type { HttpMountContext } from "../server/types";
import type { ManagementApi } from "./management";
import { admitToTier, type TierVerdict } from "./tier";
import type { OpsRouteQuery, OpsTiers } from "./types";

export interface ManagementHandlerOptions {
  api: ManagementApi;
  /** Resolved tier values. Unset tiers are disabled. */
  tiers: OpsTiers;
}

/** `GET /ops/routes` and `GET /ops/routes/{id}`. */
const ROUTES_COLLECTION = "/ops/routes";
const ROUTE_DETAIL = /^\/ops\/routes\/([^/]+)$/;
const ROUTE_EXCHANGES = /^\/ops\/routes\/([^/]+)\/exchanges$/;

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
function refuse(verdict: Exclude<TierVerdict, { kind: "admit" }>): Response {
  if (verdict.kind === "disabled") return notFound();
  if (verdict.kind === "rejected") return verdict.response;
  if (verdict.kind === "unauthenticated") {
    return missingCredentialResponse(verdict.scheme);
  }
  return jsonResponse(
    {
      error: "forbidden",
      reason: "insufficient_scope",
      scope: verdict.missing,
    },
    {
      status: 403,
      headers: {
        "www-authenticate": `Bearer realm="routecraft", error="insufficient_scope", scope="${verdict.missing}"`,
      },
    },
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
  const { api, tiers } = options;

  return async function handle(
    req: Request,
    context: HttpMountContext,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname !== ROUTES_COLLECTION && !pathname.startsWith("/ops/")) {
      return undefined;
    }

    const detailMatch = ROUTE_DETAIL.exec(pathname);
    const exchangesMatch = ROUTE_EXCHANGES.exec(pathname);

    if (pathname === ROUTES_COLLECTION || detailMatch) {
      const verdict = await admitToTier(tiers.introspection, context);
      if (verdict.kind !== "admit") return refuse(verdict);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      return pathname === ROUTES_COLLECTION
        ? listRoutes(api, url)
        : describeRoute(api, detailMatch![1]!);
    }

    if (exchangesMatch) {
      const verdict = await admitToTier(tiers.dispatch, context);
      if (verdict.kind !== "admit") return refuse(verdict);
      if (req.method !== "POST") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST" },
        });
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
    if (isRoutecraftError(error) && rcOf(error) === "RC5059") {
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
    const code = rcOf(error);
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
    // The route itself failed. The message is the framework's own and
    // carries no credential, and the code is what lets a client tell an
    // authorize refusal from a broken step.
    return jsonResponse(
      { error: "dispatch failed", code, message: (error as Error).message },
      { status: 500 },
    );
  }
}

function badRequest(message: string): Response {
  return jsonResponse({ error: "bad request", message }, { status: 400 });
}

/** Read an error's RC code without widening the caught type. */
function rcOf(error: unknown): string | undefined {
  return (error as { rc?: string }).rc;
}
