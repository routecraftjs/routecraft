import type { ActorMatcher, Principal } from "./types.ts";

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
  const copy = { ...(principal as Principal) };
  // Clone, then freeze, the policy-bearing structures, not just the top
  // level. `actor`, `mayAct`, and the policy arrays (`roles`, `scopes`,
  // `audience`) are access-control inputs: the outermost actor decides
  // `authorize({ actor })`, `mayAct` decides whether `delegate()` is
  // permitted, and roles/scopes decide RC5015/RC5038. A shallow freeze
  // would leave all of them writable through any holder of
  // `ex.principal`, so an in-process caller could push a role, rewrite
  // the current actor, or widen the consent list of an already-authentic
  // identity. Cloning first keeps this function's contract (the caller's
  // input is neither mutated nor frozen as a side effect): the spread
  // above copies only references, so freezing in place would freeze the
  // caller's structures too.
  cloneDelegationState(copy, principal as Principal);
  freezeDelegationState(copy);
  const target = Object.freeze(copy) as P;
  authentic.add(target);
  return target;
}

/**
 * Replace the policy-bearing structures of `principal` (a fresh shallow
 * copy) with clones, so the subsequent freeze never reaches the caller's
 * objects. Cycle-safe: an original-to-clone map keeps a self-referential
 * actor chain self-referential instead of unrolling it, so the depth
 * bound in `authorize()` still detects it.
 *
 * @internal
 */
function cloneDelegationState(principal: Principal, original: Principal): void {
  if (principal.roles) principal.roles = [...principal.roles];
  if (principal.scopes) principal.scopes = [...principal.scopes];
  if (principal.audience) principal.audience = [...principal.audience];
  if (principal.mayAct) principal.mayAct = cloneMatchers(principal.mayAct);
  if (principal.actor) {
    // Seed the map with the roots (the caller's original object and the
    // fresh copy) so a hand-assembled chain that points back at either
    // closes on the copy itself instead of minting an extra clone, which
    // would shift the depth authorize() counts by one hop.
    const seen = new Map<Principal, Principal>([
      [original, principal],
      [principal, principal],
    ]);
    principal.actor = cloneActor(principal.actor, seen);
  }
}

/** @internal */
function cloneMatchers(matchers: ActorMatcher[]): ActorMatcher[] {
  return matchers.map((matcher) => {
    if (typeof matcher !== "object" || matcher === null) return matcher;
    const clone: ActorMatcher = { ...matcher };
    if (Array.isArray(clone.subject)) clone.subject = [...clone.subject];
    if (Array.isArray(clone.profile)) clone.profile = [...clone.profile];
    if (clone.roles) clone.roles = [...clone.roles];
    return clone;
  });
}

/** @internal */
function cloneActor(
  actor: Principal,
  seen: Map<Principal, Principal>,
): Principal {
  const existing = seen.get(actor);
  if (existing) return existing;
  const clone: Principal = { ...actor };
  seen.set(actor, clone);
  if (clone.roles) clone.roles = [...clone.roles];
  if (clone.scopes) clone.scopes = [...clone.scopes];
  if (clone.audience) clone.audience = [...clone.audience];
  if (actor.mayAct) clone.mayAct = cloneMatchers(actor.mayAct);
  if (actor.actor) clone.actor = cloneActor(actor.actor, seen);
  return clone;
}

/**
 * Freeze the `actor` chain and the `mayAct` list of a principal in place.
 * Cycle-guarded: an actor chain is acyclic when built by `delegate()` or
 * parsed from a token, but a hand-assembled one need not be, and freezing
 * must not be the thing that hangs.
 *
 * @internal
 */
function freezeDelegationState(
  principal: Principal,
  seen: WeakSet<object> = new WeakSet(),
): void {
  // The subject's own policy arrays are the primary access-control inputs
  // (authorize() reads roles for RC5015 and scopes for RC5038). The spread
  // in markAuthentic copies the ARRAY REFERENCES, and the top-level
  // Object.freeze is shallow, so without this a holder of ex.principal
  // could push a role or scope onto an already-authentic identity.
  if (principal.roles) Object.freeze(principal.roles);
  if (principal.scopes) Object.freeze(principal.scopes);
  if (principal.audience) Object.freeze(principal.audience);
  if (principal.mayAct !== undefined) {
    for (const matcher of principal.mayAct) {
      if (typeof matcher === "object" && matcher !== null) {
        if (Array.isArray(matcher.subject)) Object.freeze(matcher.subject);
        if (Array.isArray(matcher.profile)) Object.freeze(matcher.profile);
        if (Array.isArray(matcher.roles)) Object.freeze(matcher.roles);
        Object.freeze(matcher);
      }
    }
    Object.freeze(principal.mayAct);
  }
  let current = principal.actor;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current.roles) Object.freeze(current.roles);
    if (current.scopes) Object.freeze(current.scopes);
    if (current.audience) Object.freeze(current.audience);
    if (current.mayAct !== undefined) freezeDelegationState(current, seen);
    const next = current.actor;
    Object.freeze(current);
    current = next;
  }
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
