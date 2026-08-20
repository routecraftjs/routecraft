import type { Principal } from "./types.ts";

/**
 * Module-private registry of restored principals.
 *
 * Same `WeakSet` construction as the authenticity registry in
 * `authentic.ts`, for the same reason: membership cannot be enumerated,
 * read back, copied, or transferred, so no holder of a restored principal
 * can launder a different object into the set.
 *
 * @internal
 */
const restored = new WeakSet<object>();

/**
 * Mark a principal as restored from durable storage, and freeze it.
 *
 * A suspended exchange is serialized to a store and rehydrated hours or
 * days later, possibly in a different process. What comes back is the
 * SHAPE of the principal that was verified at suspend time, with nothing
 * behind it: no live token, no signature check, no revocation lookup. It is
 * therefore deliberately NOT authentic. `authorize()` rejects it with
 * `RC5043`, which is the whole point of this mark: without it, a rehydrated
 * principal would be indistinguishable from a self-asserted plain object
 * and would report the confusing `RC5023` ("not established by a trusted
 * origin") instead of the actionable "this identity came back from a
 * suspension; re-verify it".
 *
 * This closes the direct route back to #355's bug class. Suspension is the
 * easiest way to reintroduce laundering, because the natural implementation
 * is to re-mark whatever principal was serialized as authentic on the way
 * back in.
 *
 * The principal remains readable: routes still see who the exchange was
 * running as, and `resumedBy` records who resumed it. What it cannot do is
 * pass an authorization check on its own.
 *
 * @param principal - The principal shape read back from a suspension.
 * @returns A frozen copy registered as restored. Always use the return
 *   value; the argument is neither mutated nor frozen.
 */
export function markRestored<P extends Principal>(principal: P): P {
  if (isRestored(principal)) return principal;
  const target = Object.freeze({ ...(principal as Principal) }) as P;
  restored.add(target);
  return target;
}

/**
 * Whether a value is a principal that was rehydrated from durable storage
 * (see {@link markRestored}). Restored principals are never authentic, so
 * this is not the inverse of `isAuthentic`: a plain self-asserted object is
 * neither.
 *
 * Returns a plain boolean rather than a type predicate on purpose. A
 * predicate here would narrow the FALSE branch of an already-`Principal`
 * value to `never`, which is not what a caller means by "this principal is
 * not restored".
 */
export function isRestored(principal: unknown): boolean {
  return (
    typeof principal === "object" &&
    principal !== null &&
    restored.has(principal)
  );
}
