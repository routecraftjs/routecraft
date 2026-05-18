import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import { type CallableValidator } from "../operations/validate.ts";
import { type Principal } from "./types.ts";

/**
 * Options accepted by {@link authorize}. All criteria are AND-combined: the
 * principal must satisfy every provided constraint to pass the check.
 *
 * @experimental
 */
export interface AuthorizeOptions {
  /**
   * Required roles. The principal must carry every listed role on
   * `principal.roles`. Defaults to no role check.
   */
  roles?: string[];
  /**
   * Required scopes. The principal must carry every listed scope on
   * `principal.scopes`. Defaults to no scope check.
   */
  scopes?: string[];
  /**
   * Custom predicate for advanced checks. Return `false` to reject. Runs
   * after the role and scope checks.
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
}

/**
 * Build a {@link CallableValidator} that **checks** the exchange carries an
 * authenticated principal and (optionally) that the principal has every
 * required role and scope. This is a verification primitive: it asserts an
 * existing identity meets the criteria. It does NOT issue, mint, or attach
 * credentials to the exchange.
 *
 * Throws `RC5012` when no principal is present, `RC5020` when the principal
 * carries an `expiresAt` in the past (mid-pipeline token expiry), and `RC5015`
 * when the principal fails the role / scope / predicate check.
 *
 * Most routes should declare authorization at the route boundary using the
 * pre-from `.authorize()` builder method, which wires this validator as a
 * route-entry guard. Use this function directly with `.validate(...)` only
 * when the check must run mid-pipeline (for example, after a `.process()`
 * step that swaps the principal, or inside a `.choice()` branch).
 *
 * @experimental
 *
 * @example Route-entry guard (preferred)
 * ```ts
 * craft()
 *   .id("delete-user")
 *   .description("Delete a user by id")
 *   .authorize({ roles: ["admin"] })
 *   .from(mcp({ annotations: { destructiveHint: true } }))
 *   .to(deleteUserDestination)
 * ```
 *
 * @example Mid-pipeline check (escape hatch)
 * ```ts
 * import { authorize } from "@routecraft/routecraft";
 *
 * craft()
 *   .from(http({ path: "/admin", method: "POST" }))
 *   .process(swapToServiceAccountPrincipal)
 *   .validate(authorize({ roles: ["admin"] }))
 *   .to(adminDestination)
 * ```
 */
export function authorize(
  options: AuthorizeOptions = {},
): CallableValidator<unknown, unknown> {
  const { roles, scopes, predicate, clockToleranceSec = 0 } = options;
  return (exchange: Exchange<unknown>) => {
    const principal = exchange.principal;
    if (!principal) {
      throw rcError("RC5012", new Error("No authenticated principal"), {
        message: "Authorization failed: no authenticated principal",
        suggestion:
          "Configure auth on the source so it emits a Principal (e.g. mcp({ auth: jwt(...) })). For a mid-pipeline .validate(authorize(...)) check, attach a custom principal in an earlier .process() step.",
      });
    }

    if (
      principal.expiresAt !== undefined &&
      Date.now() / 1000 > principal.expiresAt + clockToleranceSec
    ) {
      throw rcError("RC5020", new Error("Token expired"), {
        message: "Authorization failed: token expired during processing",
        suggestion:
          "The token's `exp` is in the past. A long-running step likely outlived the credential; the client should refresh and retry. To recover in-route, restructure the pipeline so authorize() runs before the slow step or attach a fresh principal in a .process() before the validator.",
      });
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

    if (scopes && scopes.length > 0) {
      const granted = new Set(principal.scopes ?? []);
      const missing = scopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        throw rcError(
          "RC5015",
          new Error(`Missing required scopes: ${missing.join(", ")}`),
          {
            message: `Authorization failed: principal is missing required scope(s): ${missing.join(", ")}`,
            suggestion:
              "Grant the principal the missing scope(s) at the IdP, or relax the authorize() requirement.",
          },
        );
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
