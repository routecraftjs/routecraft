import type { Exchange } from "../exchange.ts";
import { rcError, type RoutecraftError } from "../error.ts";
import type { CallableValidator } from "../operations/validate.ts";
import { isPrincipalExpired } from "./expiry.ts";
import { authorityOf } from "../kernel/authority.ts";
import { actorMatches } from "./delegate.ts";
import type { Principal, PrincipalProfile } from "../principal.ts";

import {
  insufficientAuthorityOf,
  isAuthorizationRefusal,
  refusal,
  type InsufficientAuthority,
} from "../authorization-refusal.ts";
import type {
  ActorSpec,
  AuthorizeOptions,
  SubjectMatcher,
} from "../authorize-options.ts";

export {
  insufficientAuthorityOf,
  isAuthorizationRefusal,
  type ActorSpec,
  type AuthorizeOptions,
  type InsufficientAuthority,
  type SubjectMatcher,
};

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
 * principal was restored from a deferral rather than verified live,
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
 * Every refusal is recognisable through {@link isAuthorizationRefusal}, which
 * is how the `http()` source and the ops dispatch door answer a refusal of
 * the route they dispatched with 401 or 403 rather than 500.
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
 *     actor: ["none", { subject: "agent:aria", issuer: "https://acme.example" }],
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
 *     actor: ["none", { subject: "agent:aria", issuer: "https://agents.example" }],
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
    const refuse = (...args: Parameters<typeof rcError>): RoutecraftError =>
      refusal(exchange, rcError(...args));
    const authority = authorityOf(exchange);
    const principal = authority.read(exchange);
    if (!principal) {
      throw refuse("RC5012", new Error("No authenticated principal"), {
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
    // A principal rehydrated from a deferral is reported separately from
    // a self-asserted one. Both are rejected, but the caller's next move
    // differs: a restored identity needs re-verification against the live
    // credential, not a mint.
    if (authority.isRestored(principal)) {
      throw refuse(
        "RC5043",
        new Error("Principal was restored from a deferral"),
        {
          message:
            "Authorization failed: principal was restored from a deferral, not verified live",
          suggestion:
            "The exchange resumed from durable storage, so its principal is a recorded shape with no live credential behind it. Re-verify the identity after resume (a fresh .authenticate() from a checked credential), or authorize the resume ingress route instead, where the resuming principal is verified live. ex.deferral.resumedBy records who resumed it.",
        },
      );
    }

    if (!authority.isAuthentic(principal)) {
      throw refuse("RC5023", new Error("Principal is not authentic"), {
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
      throw refuse("RC5020", new Error("Token expired"), {
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
      throw refuse(
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
        throw refuse(
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
        throw refuse("RC5035", new Error("Subject not permitted"), {
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
        throw refuse(
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
        if (missing.length > 0) {
          throw refusal(exchange, insufficientScope(missing, "all", effective));
        }
      }
      if (
        anyScope !== undefined &&
        !anyScope.some((scope) => granted.has(scope))
      ) {
        throw refusal(
          exchange,
          insufficientScope([...anyScope], "any", effective),
        );
      }
    }

    if (predicate && !predicate(principal)) {
      throw refuse("RC5015", new Error("Principal failed predicate check"), {
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
 *
 * `effective` records which ring the gate read, because that is what decides
 * whether a lend on the actor's ring could satisfy it at all. Carried on the
 * cause rather than inferred from the message, so a consent flow can decline
 * an impossible ask without parsing prose.
 */
function insufficientScope(
  scopes: string[],
  mode: "all" | "any",
  effective: boolean,
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
      { missing: { scopes, mode, effective } },
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
