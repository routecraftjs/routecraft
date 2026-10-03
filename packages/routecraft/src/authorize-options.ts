import type { ActorMatcher, Principal, PrincipalProfile } from "./principal.ts";

/**
 * Constraint on who is driving the request (the outermost `actor`).
 *
 * - `'none'`: reject when any actor is present. This is the DEFAULT: a
 *   capability is not reachable through delegation unless it says so, per
 *   the security-defaults policy (production-safe unconfigured default).
 * - `'any'`: accept any actor (and no actor).
 * - {@link ActorMatcher}: require an actor matching the given identity.
 * - Array: OR across entries; include `'none'` to also accept direct calls.
 * - Predicate: full custom check over `(actor, subject)`.
 *
 * Per RFC 8693 section 4.1, only the OUTERMOST actor is considered; prior
 * actors in a nested chain are audit data and never a policy input.
 */
export type ActorSpec =
  | "none"
  | "any"
  | ActorMatcher
  | Array<"none" | ActorMatcher>
  | ((actor: Principal | undefined, subject: Principal) => boolean);

/**
 * Constraint on whose authority is being exercised (the subject). All
 * provided fields must match; array-valued fields are an OR across values.
 */
export interface SubjectMatcher {
  /** Subject id(s) to accept. */
  subject?: string | string[];
  /** Issuer the subject is scoped to. */
  issuer?: string;
  /** Entity profile(s) to accept (e.g. restrict a route to `ai_agent`). */
  profile?: PrincipalProfile | PrincipalProfile[];
}

/**
 * Options accepted by {@link authorize}. All criteria are AND-combined: the
 * principal must satisfy every provided constraint to pass the check.
 */
export interface AuthorizeOptions {
  /**
   * Required roles. The principal must carry every listed role on
   * `principal.roles`. Roles are SUBJECT attributes: they describe who the
   * action is for and pass through delegation unchanged, so this checks the
   * subject even when an actor is driving. Defaults to no role check.
   */
  roles?: string[];
  /**
   * Required scopes. The principal must carry every listed scope on
   * `principal.scopes`. Scopes are CREDENTIAL capabilities: delegation
   * intersects them at every hop, so this checks the effective (narrowed)
   * set. Defaults to no scope check.
   */
  scopes?: string[];
  /**
   * Required scopes, any ONE of which admits the principal, where `scopes`
   * requires every one. For a scope family whose variants are
   * interchangeable at the door (`leave:read`, `leave:read:self`,
   * `leave:read:base`): any of them opens it, and the exact variant held
   * narrows what the pipeline returns further down.
   *
   * Refuses with RC5038 naming the whole accepted set rather than one
   * entry, because no single entry was required and a consent flow should
   * be able to offer the caller the choice.
   *
   * Composes with `scopes` as an AND of the two conditions: every entry of
   * `scopes`, and at least one entry of `anyScope`. Defaults to no check.
   *
   * An empty array is refused with RC2001 when the validator is built,
   * rather than read as no check. It is the one list on these options whose
   * empty form is not vacuously satisfied: a requirement of no scopes admits
   * everyone, while an accepted set naming nobody admits nobody, and a set
   * computed empty would otherwise remove a route's only scope gate in
   * silence. Omit the option to mean no check.
   */
  anyScope?: string[];
  /**
   * Whether `scopes` and `anyScope` may also be satisfied from the ACTOR's
   * scopes. Defaults to `false`, so a route that does not ask is unchanged.
   *
   * With `true` the scope checks read the subject's ring plus the OUTERMOST
   * actor's, which is how an agent exercises its own standing authority on
   * a caller's behalf: an agent legitimately holds scopes nobody who asks
   * it for something holds. Only the outermost actor is read, matching the
   * rule `actor` already follows (RFC 8693 section 4.1); prior actors in a
   * nested chain stay audit data.
   *
   * Never applies to `roles` under any combination. A role is what the
   * principal IS; scopes are what a keyring CARRIES, and only keyrings are
   * inheritable. An agent driving a request does not become the subject.
   *
   * A no-op under the default `actor: 'none'`, which admits no actor for
   * the flag to read. That combination is a harmless misconfiguration
   * rather than an error.
   *
   * It reads `actor.scopes`, so the actor has to carry some. An actor minted
   * by `delegate()` does. An actor parsed from a token's RFC 8693 `act`
   * claim does NOT: the claim has no scope member, and the parser will not
   * invent authority from an unstandardised one. For token-borne delegation,
   * map whatever your IdP emits with `ClaimMappers.actor`, or the check sees
   * an empty ring and refuses.
   *
   * The check reads the UNION of the two rings, so a caller passes on their
   * own scopes or on the agent's. The agent is not a cap: `delegate()`
   * deliberately does not intersect delegated scopes with the actor's own,
   * and this flag does not either. What an agent's grant bounds is the
   * additional authority a caller gains by going through it, which is why
   * this is opt-in per route rather than a context-wide setting: a gate that
   * must stay on the subject's own ring simply does not set it.
   */
  effective?: boolean;
  /**
   * Custom predicate for advanced checks. Return `false` to reject. Runs
   * after the built-in checks.
   */
  predicate?: (principal: Principal) => boolean;
  /**
   * Clock skew tolerance in seconds applied to the `expiresAt` check.
   * Matches the semantics of `jwt({ clockToleranceSec })` and
   * `jwks({ clockToleranceSec })`: a token whose `expiresAt` is less than
   * `clockToleranceSec` seconds in the past is still accepted. Defaults to
   * `0` (strict). Set to the same value used on the source-side verifier so
   * a token accepted at the route boundary is not rejected mid-pipeline by
   * a fraction of a second.
   */
  clockToleranceSec?: number;
  /**
   * Constrain whose authority is exercised. Throws RC5035 on mismatch.
   * Defaults to no subject constraint.
   */
  subject?: SubjectMatcher | ((subject: Principal) => boolean);
  /**
   * Constrain who is driving. Defaults to `'none'`: a principal carrying an
   * actor (a delegate acting on the subject's behalf) is rejected with
   * RC5034 unless the route explicitly admits one. See {@link ActorSpec}.
   */
  actor?: ActorSpec;
  /**
   * Maximum delegation chain length (number of nested actors). Applies only
   * once the `actor` spec admits an actor at all. Defaults to `1`: one
   * delegation hop is accepted, a re-delegated chain (agent to sub-agent)
   * throws RC5036 until a route raises the limit deliberately.
   */
  maxDelegationDepth?: number;
}
