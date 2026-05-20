import { type Principal } from "./types.ts";

/**
 * Module-private authenticity brand.
 *
 * A deliberately non-global `Symbol()` (NOT `Symbol.for(...)`): a global
 * registry symbol could be recreated by any caller with the same string key
 * and used to forge an authentic-looking principal, which would defeat the
 * whole point. Because this symbol is never exported, code outside this
 * module cannot reference it, so it cannot stamp the brand.
 *
 * The brand is applied as a non-enumerable property. Non-enumerable means a
 * plain object spread (`{ ...principal, roles: ["admin"] }`) does NOT copy
 * it, so a principal cannot be silently elevated by copying an existing one;
 * the only way to obtain a trusted principal is to go through a trusted
 * origin ({@link markAuthentic} via `authenticate()` or a source verifier).
 *
 * @internal
 */
const AUTHENTIC: unique symbol = Symbol("routecraft.auth.authentic");

/**
 * Mark a principal as authentic and freeze it.
 *
 * Authenticity is the framework's signal that a principal was established by
 * a trusted origin: an explicit `authenticate()` mint, or a source-side
 * verifier (`jwt()`, `jwks()`, OAuth). `authorize()` trusts only branded
 * principals; a plain object written onto
 * `headers["routecraft.auth.principal"]` is rejected.
 *
 * Idempotent: a principal that is already authentic is returned unchanged.
 * The result is frozen so the brand cannot be stripped or the identity
 * tampered with downstream. When handed an already-frozen but unbranded
 * principal, a fresh branded copy is returned rather than throwing.
 *
 * This is a trusted primitive. It is exported for adapter and source authors
 * who verify identity themselves (for example a custom Slack or e-mail
 * source) and need to brand the principal they resolved. Application route
 * code should mint identities with `authenticate()` instead.
 *
 * @experimental
 */
export function markAuthentic<P extends Principal>(principal: P): P {
  if (isAuthentic(principal)) return principal;
  const target = (
    Object.isFrozen(principal) ? { ...(principal as Principal) } : principal
  ) as P;
  Object.defineProperty(target, AUTHENTIC, { value: true });
  return Object.freeze(target);
}

/**
 * Whether a value is a principal that was established by a trusted origin
 * (see {@link markAuthentic}). Returns `false` for plain objects, `null`,
 * `undefined`, and non-objects.
 *
 * @experimental
 */
export function isAuthentic(principal: unknown): principal is Principal {
  return (
    typeof principal === "object" &&
    principal !== null &&
    (principal as Record<symbol, unknown>)[AUTHENTIC] === true
  );
}
