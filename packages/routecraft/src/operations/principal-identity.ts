import type { Principal } from "../principal.ts";

/**
 * Who is asking, as a JSON-encodable chain: see {@link principalIdentity}.
 *
 * @internal
 */
export type PrincipalIdentity = Array<[string | null, string] | number>;

/**
 * `[issuer, subject]` for the principal and then for every `actor` hop,
 * outermost first, or `null` when the exchange carries no principal. The
 * default `.cache()` and `.dedupe()` keys both include it, so two callers
 * sending the same body never share an entry or dedupe each other. The
 * actor chain is part of who is asking: a delegate acting for the same
 * subject can be authorized differently, so it is kept apart from another
 * delegate.
 *
 * A hand-assembled self-referential chain ends in the index of the hop it
 * loops back to, so it neither spins nor keys like the same chain without
 * the loop.
 *
 * @internal
 */
export function principalIdentity(
  principal: Principal | undefined,
): PrincipalIdentity | null {
  if (!principal) return null;
  const chain: PrincipalIdentity = [];
  const seen = new Map<Principal, number>();
  for (let hop: Principal | undefined = principal; hop; hop = hop.actor) {
    const loop = seen.get(hop);
    if (loop !== undefined) {
      chain.push(loop);
      break;
    }
    seen.set(hop, chain.length);
    chain.push([hop.issuer ?? null, hop.subject]);
  }
  return chain;
}
