import type { Exchange } from "../exchange.ts";
import { rcError, type RoutecraftError } from "../error.ts";
import type { CallableValidator } from "../operations/validate.ts";
import { isAuthentic } from "./authentic.ts";
import { isPrincipalExpired } from "./expiry.ts";
import { isRestored } from "./restored.ts";
import { actorMatches } from "./delegate.ts";
import type { ActorMatcher, Principal, PrincipalProfile } from "./types.ts";

/**
 * Machine-readable detail attached to an `RC5038` error's cause, naming
 * exactly what the principal lacked. Read it off `error.cause` to drive a
 * consent flow:
 *
 * ```ts
 * const missing = (err.cause as InsufficientAuthority | undefined)?.missing
 * if (missing?.mode === "any") offerChoice(missing.scopes)
 * else if (missing?.scopes) requestGrant(missing.scopes)
 * ```
 *
 * Carries the scopes the principal lacked for a `scopes` refusal, and the
 * whole accepted set for an `anyScope` one, where any single entry would
 * have opened the door.
 *
 * In-process only: `RoutecraftError.toJSON()` serialises the cause's message
 * and stack, not its own properties, so a consumer reading the failure from
 * a serialised event log sees the scope names in the message text but not
 * this structured field.
 */
export interface InsufficientAuthority extends Error {
  missing: {
    scopes: string[];
    /**
     * How to read `scopes`. `"all"` lists the required scopes the
     * principal lacked, every one of them needed. `"any"` lists the whole
     * accepted set of an `anyScope` check, of which ONE suffices, so a
     * consent flow can offer the choice rather than requesting all of them.
     *
     * Optional because an application throwing this shape itself (the
     * documented workaround before `anyScope` existed) predates the field;
     * `authorize()` always sets it. Absent means `"all"`.
     */
    mode?: "all" | "any";
  };
}

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
   * Widening a check this way makes the agent's standing scopes the ceiling
   * of what any caller can reach through it, which is why it is opt-in per
   * route rather than a context-wide setting: a gate that must stay on the
   * subject's own ring simply does not set it.
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

/**
 * Depth of the actor chain: 0 for no actor, 1 per nesting level.
 *
 * Stops at `limit + 1` because the caller only ever asks "is this deeper
 * than the limit", never "how much deeper". The bound doubles as the cycle
 * guard: a hand-assembled self-referential chain would otherwise spin here
 * forever, turning a policy check into a hung event loop.
 */
function chainDepth(principal: Principal, limit: number): number {
  const ceiling = Number.isFinite(limit) ? Math.max(0, limit) + 1 : 1;
  let depth = 0;
  let current = principal.actor;
  while (current !== undefined && depth < ceiling) {
    depth += 1;
    current = current.actor;
  }
  return depth;
}

function subjectMatches(
  principal: Principal,
  matcher: SubjectMatcher,
): boolean {
  if (matcher.subject !== undefined) {
    const subjects = Array.isArray(matcher.subject)
      ? matcher.subject
      : [matcher.subject];
    if (!subjects.includes(principal.subject)) return false;
  }
  if (matcher.issuer !== undefined && principal.issuer !== matcher.issuer) {
    return false;
  }
  if (matcher.profile !== undefined) {
    const profiles: PrincipalProfile[] = Array.isArray(matcher.profile)
      ? matcher.profile
      : [matcher.profile];
    if (
      principal.subjectProfile === undefined ||
      !profiles.includes(principal.subjectProfile)
    ) {
      return false;
    }
  }
  return true;
}

function actorAllowed(
  spec: ActorSpec,
  actor: Principal | undefined,
  subject: Principal,
): boolean {
  if (typeof spec === "function") return spec(actor, subject);
  if (spec === "any") return true;
  if (spec === "none") return actor === undefined;
  if (Array.isArray(spec)) {
    return spec.some((entry) =>
      entry === "none"
        ? actor === undefined
        : actor !== undefined && actorMatches(actor, entry),
    );
  }
  return actor !== undefined && actorMatches(actor, spec);
}

/**
 * Build a {@link CallableValidator} that **checks** the exchange carries an
 * authenticated principal and (optionally) that the principal has every
 * required role and scope, an admissible subject, and an admissible actor.
 * This is a verification primitive: it asserts an existing identity meets
 * the criteria. It does NOT issue, mint, or attach credentials to the
 * exchange (use `.authenticate()` / `.delegate()` for that), and it trusts
 * only principals established by a trusted origin.
 *
 * Delegation awareness (RFC 8693): `roles` are checked on the subject
 * (they pass through delegation), `scopes` on the effective narrowed set,
 * and the `actor` spec on the OUTERMOST actor only; nested prior actors are
 * audit data. The default `actor: 'none'` means a route is not reachable
 * through delegation unless it says so.
 *
 * Scope checks read the subject's ring alone unless `effective: true`
 * widens them to the outermost actor's as well, which is how an agent
 * exercises its own standing authority on a caller's behalf. Roles are
 * never widened that way: a role is what the principal IS, and only a
 * keyring is inheritable.
 *
 * Throws `RC5012` when no principal is present, `RC5043` when the
 * principal was restored from a suspension rather than verified live,
 * `RC5023` when a principal is present but was not established by a
 * trusted origin, `RC5020` on
 * expiry, `RC5034` when the actor is not admitted, `RC5035` when the
 * subject is not admitted, `RC5036` when the delegation chain exceeds
 * `maxDelegationDepth`, `RC5015` when the principal fails the role or
 * predicate check, and `RC5038` when a required scope is missing
 * (recoverable; the cause carries `missing.scopes`, naming the whole
 * accepted set for an `anyScope` refusal).
 *
 * Throws `RC2001` when the validator is built with an empty `anyScope`,
 * which would name an accepted set that admits nobody.
 *
 * Most routes should declare authorization at the route boundary using the
 * pre-from `.authorize()` builder method, which wires this validator as a
 * route-entry guard. Use this function directly with `.validate(...)` only
 * when the check must run mid-pipeline (for example, after an
 * `.authenticate()` or `.delegate()` step, or inside a `.choice()` branch).
 *
 * @example Route-entry guard (preferred)
 * ```ts
 * craft()
 *   .id("delete-user")
 *   .authorize({ roles: ["admin"], actor: "none" })
 *   .from(mcp({ annotations: { destructiveHint: true } }))
 *   .to(deleteUserDestination)
 * ```
 *
 * @example Admit one named agent alongside direct callers
 * ```ts
 * craft()
 *   .id("send-reply")
 *   .authorize({
 *     scopes: ["mail:send"],
 *     actor: ["none", { subject: "agent:zoe", issuer: "https://eywa.example" }],
 *   })
 *   .from(direct())
 *   .to(smtp())
 * ```
 *
 * @example Any one of a scope family, satisfiable by the agent's own ring
 * ```ts
 * craft()
 *   .id("read-leave")
 *   .authorize({
 *     anyScope: ["leave:read", "leave:read:self", "leave:read:base"],
 *     effective: true,
 *     actor: ["none", { subject: "agent:zoe", issuer: "https://agents.example" }],
 *   })
 *   .from(direct())
 *   .to(leaveDestination)
 * ```
 *
 * @example Mid-pipeline check (escape hatch)
 * ```ts
 * import { authorize } from "@routecraft/routecraft";
 *
 * craft()
 *   .from(http({ path: "/admin", method: "POST" }))
 *   .authenticate(() => ({ subject: "service-account", roles: ["admin"] }))
 *   .validate(authorize({ roles: ["admin"] }))
 *   .to(adminDestination)
 * ```
 */
export function authorize(
  options: AuthorizeOptions = {},
): CallableValidator<unknown, unknown> {
  const {
    roles,
    scopes,
    anyScope,
    effective = false,
    predicate,
    clockToleranceSec = 0,
    subject: subjectSpec,
    actor: actorSpec = "none",
    maxDelegationDepth = 1,
  } = options;
  if (anyScope !== undefined && anyScope.length === 0) {
    throw rcError("RC2001", new Error("Empty anyScope"), {
      message:
        "authorize({ anyScope: [] }) names an accepted set that admits nobody",
      suggestion:
        "Omit anyScope for no scope check, or list the scopes that admit the caller. An empty accepted set is refused rather than read either way: unlike scopes: [], which is a requirement of nothing and vacuously satisfied, an empty any-of list is satisfiable by nobody, and a set computed empty (a tenant lookup that missed, an unset environment variable) would otherwise remove the route's only scope gate in silence.",
    });
  }
  return (exchange: Exchange<unknown>) => {
    const principal = exchange.principal;
    if (!principal) {
      throw rcError("RC5012", new Error("No authenticated principal"), {
        message: "Authorization failed: no authenticated principal",
        suggestion:
          "Configure auth on the source so it emits a Principal (e.g. mcp({ auth: jwt(...) })). For a mid-pipeline check, mint a principal with the .authenticate() operation (or the authenticate() helper) before authorize().",
      });
    }

    // Trust only principals established by a trusted origin: a source-side
    // verifier (jwt/jwks/oauth) or an explicit authenticate()/delegate()
    // mint. A plain object written onto headers["routecraft.auth.principal"]
    // is treated as self-asserted and rejected, so identity cannot be forged
    // by an incidental header write or by spreading an existing principal
    // with elevated roles.
    // A principal rehydrated from a suspension is reported separately from
    // a self-asserted one. Both are rejected, but the caller's next move
    // differs: a restored identity needs re-verification against the live
    // credential, not a mint.
    if (isRestored(principal)) {
      throw rcError(
        "RC5043",
        new Error("Principal was restored from a suspension"),
        {
          message:
            "Authorization failed: principal was restored from a suspension, not verified live",
          suggestion:
            "The exchange resumed from durable storage, so its principal is a recorded shape with no live credential behind it. Re-verify the identity after resume (a fresh .authenticate() from a checked credential), or authorize the resume ingress route instead, where the resuming principal is verified live. ex.suspension.resumedBy records who resumed it.",
        },
      );
    }

    if (!isAuthentic(principal)) {
      throw rcError("RC5023", new Error("Principal is not authentic"), {
        message:
          "Authorization failed: principal was not established by a trusted origin",
        suggestion:
          'Mint the identity with the .authenticate() operation or the authenticate() helper (or let a source verifier such as jwt()/jwks()/oauth() attach it). A plain object assigned to headers["routecraft.auth.principal"] is not trusted.',
      });
    }

    // Boundary semantics (floored, inclusive, fail-closed on non-finite) live
    // on the shared predicate so this gate and the HTTP bearer middleware can
    // never disagree by a second.
    if (isPrincipalExpired(principal, clockToleranceSec)) {
      throw rcError("RC5020", new Error("Token expired"), {
        message: "Authorization failed: token expired during processing",
        suggestion:
          "The token's `exp` is in the past (or `expiresAt` / `clockToleranceSec` was non-finite). A long-running step likely outlived the credential; the client should refresh and retry. To recover in-route, restructure the pipeline so authorize() runs before the slow step or attach a fresh principal in a .process() before the validator.",
      });
    }

    // Actor gate before role/scope checks: "you may not be here as a
    // delegate" is a different fact from "you lack a role", and the actor
    // decision must not leak which roles would have sufficed.
    const currentActor = principal.actor;
    if (!actorAllowed(actorSpec, currentActor, principal)) {
      throw rcError(
        "RC5034",
        new Error(
          currentActor === undefined
            ? "Direct calls are not admitted by the actor spec"
            : `Actor "${currentActor.subject}" is not admitted`,
        ),
        {
          message:
            currentActor === undefined
              ? "Authorization failed: this route requires a delegated actor and the call is direct"
              : `Authorization failed: actor "${currentActor.subject}" is not permitted to act on the subject's behalf here`,
          suggestion:
            "Declare the permitted actor(s) on the route's authorize({ actor }) (the default 'none' rejects all delegation), or have the permitted party perform the call.",
        },
      );
    }

    if (currentActor !== undefined) {
      const depth = chainDepth(principal, maxDelegationDepth);
      // Fail closed on a non-finite limit, matching the expiresAt /
      // clockToleranceSec discipline above: `depth > NaN` is always false,
      // so a misconfigured limit (e.g. Number(unsetEnvVar)) would silently
      // accept a chain of any depth instead of rejecting it.
      if (!Number.isFinite(maxDelegationDepth) || depth > maxDelegationDepth) {
        throw rcError(
          "RC5036",
          new Error(
            `Delegation depth ${depth} exceeds maximum ${maxDelegationDepth}`,
          ),
          {
            message: `Authorization failed: delegation chain of depth ${depth} exceeds this route's maximum of ${maxDelegationDepth}`,
            suggestion:
              "Have an agent closer to the subject perform the call, or raise maxDelegationDepth on the route deliberately. Only the outermost actor is a policy input; deeper chains add audit surface, not authority.",
          },
        );
      }
    }

    if (subjectSpec !== undefined) {
      const ok =
        typeof subjectSpec === "function"
          ? subjectSpec(principal)
          : subjectMatches(principal, subjectSpec);
      if (!ok) {
        throw rcError("RC5035", new Error("Subject not permitted"), {
          message: `Authorization failed: subject "${principal.subject}" is not permitted by this route's subject constraint`,
          suggestion:
            "Check the route's authorize({ subject }) constraint (subject id, issuer, profile) against the caller's identity.",
        });
      }
    }

    if (roles && roles.length > 0) {
      const granted = new Set(principal.roles ?? []);
      const missing = roles.filter((r) => !granted.has(r));
      if (missing.length > 0) {
        throw rcError(
          "RC5015",
          new Error(`Missing required roles: ${missing.join(", ")}`),
          {
            message: `Authorization failed: principal is missing required role(s): ${missing.join(", ")}`,
            suggestion:
              "Grant the principal the missing role(s) at the IdP, or relax the authorize() requirement.",
          },
        );
      }
    }

    if ((scopes && scopes.length > 0) || anyScope !== undefined) {
      const granted = grantedScopes(principal, effective);
      if (scopes && scopes.length > 0) {
        const missing = scopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) throw insufficientScope(missing, "all");
      }
      if (
        anyScope !== undefined &&
        !anyScope.some((scope) => granted.has(scope))
      ) {
        throw insufficientScope([...anyScope], "any");
      }
    }

    if (predicate && !predicate(principal)) {
      throw rcError("RC5015", new Error("Principal failed predicate check"), {
        message: "Authorization failed: principal failed predicate check",
        suggestion:
          "Adjust the predicate or the principal's claims so the check passes.",
      });
    }

    return exchange.body;
  };
}

/**
 * The scopes a check may draw on: the principal's own, plus the outermost
 * actor's when `effective` widens the ring.
 *
 * The bound is `principal.actor` and nothing deeper, deliberately. Walking
 * the chain would read authority from parties `authorize({ actor })` never
 * considers (RFC 8693 section 4.1), undo the intersection `delegate()`
 * applies at every hop, and let authority accumulate with delegation depth,
 * which fails open where missing authority fails closed.
 */
function grantedScopes(principal: Principal, effective: boolean): Set<string> {
  const granted = new Set(principal.scopes ?? []);
  if (effective) {
    for (const scope of principal.actor?.scopes ?? []) granted.add(scope);
  }
  return granted;
}

/**
 * The RC5038 refusal, carrying `missing.scopes` for a consent flow.
 *
 * RC5038 rather than RC5015: a missing scope is the one recoverable failure
 * (RFC 9470 / RFC 6750 insufficient_scope shape). The identity is valid, so
 * a consent flow could add the scope and the call could be retried. Role and
 * predicate failures stay RC5015 because no ceremony changes who the subject
 * is.
 *
 * `mode` decides what the scope list means. `"all"` names the entries the
 * principal lacked, since every one was required. `"any"` names the whole
 * accepted set, since no single entry was required and any one of them would
 * have opened the door.
 */
function insufficientScope(
  scopes: string[],
  mode: "all" | "any",
): RoutecraftError {
  const detail =
    mode === "all"
      ? `missing required scope(s): ${scopes.join(", ")}`
      : `holding none of the accepted scope(s): ${scopes.join(", ")}`;
  return rcError(
    "RC5038",
    Object.assign(
      new Error(
        mode === "all"
          ? `Missing required scopes: ${scopes.join(", ")}`
          : `Missing any of the accepted scopes: ${scopes.join(", ")}`,
      ),
      { missing: { scopes, mode } },
    ) satisfies InsufficientAuthority,
    {
      message: `Authorization failed: principal is ${detail}`,
      suggestion:
        mode === "all"
          ? "The identity is valid but lacks scope. Obtain the missing scope(s) via your consent/grant flow (the cause's `missing.scopes` lists them), or grant them at the IdP, then retry."
          : "The identity is valid but carries none of the accepted scopes. Obtain any ONE of them via your consent/grant flow (the cause's `missing.scopes` lists the full accepted set, so a consent flow can offer the choice), or grant one at the IdP, then retry.",
    },
  );
}

/**
 * Scopes in `required` the principal does not carry on its own ring.
 *
 * The one scope comparison in the framework. `authorize()` and the ops
 * management tiers both gate on it, and the property an operator is promised,
 * that there is a single scope model rather than two, is only true while they
 * share this function rather than a comment saying they agree.
 *
 * Reads the principal's own scopes only, which is the ring the ops tiers
 * gate on. `authorize()` compares against a ring it builds itself through
 * the shared {@link grantedScopes}, because `effective: true` may widen that
 * ring to the outermost actor's; the widening is a property of that one gate
 * rather than of the scope model, and membership is decided the same way on
 * both paths.
 */
export function missingScopes(
  principal: Principal,
  required: readonly string[],
): string[] {
  const granted = grantedScopes(principal, false);
  return required.filter((scope) => !granted.has(scope));
}
