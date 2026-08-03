import { rcError } from "../error.ts";
import { authenticate, type PrincipalClaims } from "./authenticate.ts";
import { isAuthentic, markAuthentic } from "./authentic.ts";
import {
  type ActorMatcher,
  type Principal,
  type PrincipalProfile,
} from "./types.ts";

/**
 * Options accepted by {@link delegate}.
 */
export interface DelegateOptions {
  /**
   * Scope ceiling from the caller's consent mechanism (an OAuth grant, a
   * grant table, static config). Effective scopes on the delegated
   * principal are ALWAYS the intersection of the subject's scopes, this
   * ceiling, and the actor's own scopes; omitting the ceiling intersects
   * only subject and actor. Roles are never intersected: the subject's
   * roles pass through (they describe who the subject IS, RFC 9068
   * section 2.2.3.1), and the actor's own roles stay on `actor.roles`
   * for matching.
   */
  scopes?: string[];
  /** Consent record id to carry on the delegated principal for audit. */
  grantId?: string;
}

/**
 * Whether `actor` satisfies `matcher`. All provided matcher fields must
 * match (AND); array-valued fields are an OR across their values.
 *
 * @internal Shared between `delegate()` (mayAct) and `authorize()` (actor
 * spec) so "does this actor match" has exactly one definition.
 */
export function actorMatches(actor: Principal, matcher: ActorMatcher): boolean {
  if (matcher.subject !== undefined) {
    const subjects = Array.isArray(matcher.subject)
      ? matcher.subject
      : [matcher.subject];
    if (!subjects.includes(actor.subject)) return false;
  }
  if (matcher.issuer !== undefined && actor.issuer !== matcher.issuer) {
    return false;
  }
  if (matcher.profile !== undefined) {
    const profiles: PrincipalProfile[] = Array.isArray(matcher.profile)
      ? matcher.profile
      : [matcher.profile];
    if (
      actor.subjectProfile === undefined ||
      !profiles.includes(actor.subjectProfile)
    ) {
      return false;
    }
  }
  if (matcher.roles !== undefined && matcher.roles.length > 0) {
    const granted = new Set(actor.roles ?? []);
    if (!matcher.roles.every((r) => granted.has(r))) return false;
  }
  return true;
}

function intersect(
  base: string[] | undefined,
  ...ceilings: Array<string[] | undefined>
): string[] | undefined {
  let result = base;
  for (const ceiling of ceilings) {
    if (ceiling === undefined) continue;
    if (result === undefined) {
      // A ceiling with no base grants nothing: the subject never held any
      // scope for the ceiling to narrow.
      return [];
    }
    const allowed = new Set(ceiling);
    result = result.filter((s) => allowed.has(s));
  }
  return result;
}

/**
 * Mint a delegated {@link Principal}: `subject` acting through `actor`.
 *
 * This is the delegation sibling of `authenticate()`: a pure function with
 * no I/O. The caller resolves WHAT the actor may do (a consent record, an
 * OAuth grant, static config) and passes the resulting scope ceiling;
 * `delegate()` mints. Where the ceiling came from is the caller's business,
 * exactly as `authenticate()` does not care how an identity was verified.
 *
 * Semantics (see the delegation table in the docs):
 *
 * - `subject`, `roles`, `claims`, `email`, `name` pass through unchanged.
 * - `scopes` become the intersection of the subject's scopes, the
 *   `options.scopes` ceiling, and the actor's own scopes.
 * - `actor` is set to the minted actor principal; a pre-existing actor
 *   nests one level down, expressing the chain (RFC 8693 section 4.1).
 *   The outermost entry is the current actor.
 * - `expiresAt` becomes the earlier of the subject's and the actor's.
 * - The result carries a fresh authenticity brand; nested actors are
 *   branded transitively because the chain is constructed here and only
 *   here.
 *
 * Routecraft supports delegation only, never impersonation (RFC 8693
 * section 1.1): the subject is always retained and the actor always named.
 *
 * @throws RC5023 when `subject` is not an authentic principal. A chain may
 *   only be built on an identity the framework already trusts; this is what
 *   keeps authenticity a property of the whole chain.
 * @throws RC5037 when `subject.mayAct` is present and no entry matches the
 *   requested actor.
 *
 * @example
 * ```ts
 * const delegated = delegate(ex.principal, zoeIdentity, {
 *   scopes: grant.scopes,
 *   grantId: grant.id,
 * })
 * ```
 */
export function delegate(
  subject: Principal,
  actor: PrincipalClaims,
  options: DelegateOptions = {},
): Principal {
  if (!isAuthentic(subject)) {
    throw rcError("RC5023", new Error("Subject principal is not authentic"), {
      message:
        "delegate() requires an authentic subject principal; a self-asserted object cannot be delegated",
      suggestion:
        "Mint the subject with .authenticate() / authenticate() (or let a source verifier attach it) before delegating. delegate() refuses to build a chain on an untrusted identity.",
    });
  }

  // Mint the actor first (validates its own claims, e.g. non-empty subject)
  // so a bad actor identity fails before we touch the subject.
  const actorPrincipal = authenticate(actor);

  if (subject.mayAct !== undefined) {
    const permitted = subject.mayAct.some((m) =>
      actorMatches(actorPrincipal, m),
    );
    if (!permitted) {
      throw rcError("RC5037", new Error("Actor not permitted by mayAct"), {
        message: `delegate() refused: subject "${subject.subject}" has not permitted "${actorPrincipal.subject}" to act on their behalf`,
        suggestion:
          "Obtain the subject's consent (add a matching entry to the subject's mayAct, typically from your grant store) and retry. Do not widen mayAct without an explicit consent event.",
      });
    }
  }

  const scopes = intersect(subject.scopes, options.scopes, actor.scopes);

  const chainedActor: Principal =
    subject.actor === undefined
      ? actorPrincipal
      : markAuthentic({ ...actorPrincipal, actor: subject.actor });

  const expiresAt =
    subject.expiresAt !== undefined || actorPrincipal.expiresAt !== undefined
      ? Math.min(
          subject.expiresAt ?? Number.POSITIVE_INFINITY,
          actorPrincipal.expiresAt ?? Number.POSITIVE_INFINITY,
        )
      : undefined;

  const delegated: Principal = {
    ...subject,
    actor: chainedActor,
  };
  if (scopes !== undefined) delegated.scopes = scopes;
  else delete delegated.scopes;
  if (expiresAt !== undefined) delegated.expiresAt = expiresAt;
  if (options.grantId !== undefined) delegated.grantId = options.grantId;

  return markAuthentic(delegated);
}
