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
