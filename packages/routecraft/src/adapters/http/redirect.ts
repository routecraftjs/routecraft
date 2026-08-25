import type { HttpResult } from "./types";

/**
 * Statuses that carry a redirect.
 *
 * `304 Not Modified` is deliberately absent: it is a cache answer rather than
 * a hop, it names no `Location`, and a route asking about redirects is asking
 * about hops. The obvious hand-rolled predicate (`status >= 300 && status <
 * 400`) includes it and therefore disagrees with the adapter, which is why
 * this set is exported rather than left for every route to re-derive.
 */
export const HTTP_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * True when a result carries a redirect the route may choose to follow.
 *
 * The predicate a `redirect: "manual"` route branches on, and the same rule
 * the adapter itself applies when deciding that a 3xx is the outcome the
 * route asked for rather than an http error. Excludes `304`, per
 * {@link HTTP_REDIRECT_STATUSES}.
 *
 * @example
 * ```typescript
 * .enrich(http({ url: (ex) => ex.body.url, redirect: "manual" }))
 * .choice(when(isRedirect, revalidateAndFollow))
 * ```
 */
export function isRedirect(result: Pick<HttpResult, "status">): boolean {
  return HTTP_REDIRECT_STATUSES.has(result.status);
}
