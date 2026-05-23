import { type Principal } from "./types.ts";

/**
 * Module-private registry of authentic principals.
 *
 * Membership in this `WeakSet` is the authenticity signal. A `WeakSet` is
 * used deliberately instead of a property brand: set membership cannot be
 * enumerated, read back, copied, or transferred. Code that holds a genuine
 * authentic principal (userland receives them via `ex.principal`, `.process()`
 * callbacks, and event payloads) has no way to mark a different object as
 * authentic. A property-based brand would be reflectable via
 * `Object.getOwnPropertySymbols()` even when keyed by a private,
 * non-enumerable symbol, so any holder of a real principal could copy the
 * brand onto a forged object; the `WeakSet` closes that hole.
 *
 * Only {@link markAuthentic} adds to this set, and it is the single point at
 * which trust is conferred.
 *
 * @internal
 */
const authentic = new WeakSet<object>();

/**
 * DANGER: every principal passed to this function becomes trusted by
 * `authorize()`. Call it ONLY after you have verified the caller's identity
 * yourself. Passing an unverified or attacker-influenced principal is a
 * privilege-escalation bug, the framework cannot check your work here.
 *
 * Mark a principal as authentic and freeze it. Authenticity is the
 * framework's signal that a principal was established by a trusted origin: an
 * explicit `authenticate()` mint, or a source-side verifier (`jwt()`,
 * `jwks()`, OAuth). `authorize()` trusts only branded principals; a plain
 * object written onto `headers["routecraft.auth.principal"]` is rejected.
 *
 * Always returns a frozen copy (never the input object, so the caller's
 * principal is not mutated or frozen as a side effect), registered in the
 * private authenticity set. Idempotent: a principal that is already authentic
 * is returned unchanged.
 *
 * Returning a frozen object matters: the exchange constructor only clones an
 * unfrozen principal header, so a frozen branded principal flows downstream
 * by reference and keeps its set membership. Always use the return value;
 * never assume the argument was branded in place.
 *
 * This is a trusted primitive, exported for adapter and source authors who
 * verify identity themselves (for example a custom Slack or e-mail source).
 * Application route code should mint identities with `authenticate()` instead.
 */
export function markAuthentic<P extends Principal>(principal: P): P {
  if (isAuthentic(principal)) return principal;
  const target = Object.freeze({ ...(principal as Principal) }) as P;
  authentic.add(target);
  return target;
}

/**
 * Whether a value is a principal that was established by a trusted origin
 * (see {@link markAuthentic}). Returns `false` for plain objects, `null`,
 * `undefined`, and non-objects.
 */
export function isAuthentic(principal: unknown): principal is Principal {
  return (
    typeof principal === "object" &&
    principal !== null &&
    authentic.has(principal)
  );
}
