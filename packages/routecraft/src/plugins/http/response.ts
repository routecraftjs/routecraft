import { missingCredentialReason } from "./auth.ts";
import { bearerChallenge } from "../server/protected-resource.ts";

/**
 * The JSON response every routecraft-owned HTTP surface answers with.
 *
 * Shared so the wire format is decided once: a change to it (a `cache-control`
 * on probe responses, a `vary` header) would otherwise be applied to whichever
 * copy the author happened to be looking at, and the surfaces on one listener
 * would drift apart.
 */
export function jsonResponse(
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
 * The 401 every routecraft-owned surface answers when a credential is
 * required and none was presented.
 *
 * Shared alongside {@link jsonResponse} for the same reason: the http
 * dispatcher and the ops management tiers both refuse a credential-free
 * caller, and two copies of this shape would drift the moment one of them
 * gained a header. The reason string comes from `missingCredentialReason`
 * so the body and the `auth:rejected` event it pairs with cannot disagree.
 */
export function missingCredentialResponse(
  scheme: string,
  requestUrl: string,
): Response {
  return jsonResponse(
    { error: "unauthorized", reason: missingCredentialReason(scheme) },
    { status: 401, headers: bearerChallengeHeaders(scheme, requestUrl) },
  );
}

/**
 * The `WWW-Authenticate` header a refusal carries, present only for the
 * bearer scheme.
 *
 * RFC 7235: announcing `Bearer` to an api-key client points it at a
 * ceremony it cannot perform. The bearer challenge carries the RFC 9728
 * `resource_metadata` hint, so a refused caller can discover who issues.
 * One helper so every refusal decides the scheme question the same way.
 */
export function bearerChallengeHeaders(
  scheme: string | undefined,
  requestUrl: string,
  params?: Record<string, string>,
): Record<string, string> {
  if (scheme !== "bearer") return {};
  return {
    "www-authenticate": bearerChallenge({
      requestUrl,
      ...(params !== undefined ? { params } : {}),
    }),
  };
}

/**
 * The 403 a caller gets when its identity is valid and its credential lacks
 * a scope: the ops tier check's refusal and a route's own `RC5038` alike,
 * so a client reads both the same way.
 *
 * `anyOf` marks a list that is an accepted set, of which one entry
 * suffices, with `scope_mode: "any"`; read as requirements it would send a
 * consent flow after every member of the family. The challenge then omits
 * `scope`, since RFC 6750 reads that attribute as the scope the token needs.
 */
export function insufficientScopeResponse(
  scheme: string | undefined,
  requestUrl: string,
  refusal: { scope: string; anyOf?: boolean },
): Response {
  const { scope, anyOf = false } = refusal;
  return jsonResponse(
    {
      error: "forbidden",
      reason: "insufficient_scope",
      scope,
      ...(anyOf ? { scope_mode: "any" } : {}),
    },
    {
      status: 403,
      headers: bearerChallengeHeaders(scheme, requestUrl, {
        error: "insufficient_scope",
        ...(anyOf || scope.length === 0 ? {} : { scope }),
      }),
    },
  );
}

/**
 * The empty-body 405 every routecraft-owned surface answers.
 *
 * Shared for the same reason as the shapes above: the ops mount, the health
 * report and the http built-ins all refuse a wrong method identically, and
 * separate copies drift the first time one gains a header.
 */
export function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}
