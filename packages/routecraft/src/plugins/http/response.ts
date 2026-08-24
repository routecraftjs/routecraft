import { missingCredentialReason } from "./auth.ts";

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
export function missingCredentialResponse(scheme: string): Response {
  const headers: Record<string, string> = {};
  // WWW-Authenticate per RFC 7235 only when the scheme is bearer. Sending
  // `Bearer` on an api-key route mis-signals the protocol.
  if (scheme === "bearer") {
    headers["www-authenticate"] = 'Bearer realm="routecraft"';
  }
  return jsonResponse(
    { error: "unauthorized", reason: missingCredentialReason(scheme) },
    { status: 401, headers },
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
