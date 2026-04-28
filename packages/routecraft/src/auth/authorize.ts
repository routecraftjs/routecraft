import { type Exchange } from "../exchange.ts";
import { rcError } from "../error.ts";
import { type CallableValidator } from "../operations/validate.ts";
import { type Principal } from "./types.ts";

/**
 * Options for {@link requirePrincipal}. All criteria are AND-combined: the
 * principal must satisfy every provided constraint to pass.
 *
 * @experimental
 */
export interface RequirePrincipalOptions {
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
}

/**
 * Build a {@link CallableValidator} that asserts the exchange carries an
 * authenticated principal and (optionally) that the principal has every
 * required role and scope. Throws `RC5012` when no principal is present
 * and `RC5015` when the principal fails an authorization check.
 *
 * Used as the underlying validator for the `.authorize()` DSL sugar; you
 * can also pass it directly to `.validate()` if you need to compose it
 * with other validators.
 *
 * @experimental
 *
 * @example
 * ```ts
 * craft()
 *   .from(mcpTool({ name: "delete-user" }))
 *   .validate(requirePrincipal({ roles: ["admin"] }))
 *   .to(...)
 * ```
 */
export function requirePrincipal(
  options: RequirePrincipalOptions = {},
): CallableValidator<unknown, unknown> {
  const { roles, scopes, predicate } = options;
  return (exchange: Exchange<unknown>) => {
    const principal = exchange.principal;
    if (!principal) {
      throw rcError("RC5012", new Error("No authenticated principal"), {
        message: "Authorization failed: no authenticated principal",
        suggestion:
          "Configure auth on the source (e.g. mcp({ auth: jwt(...) })) or attach a custom principal in a .process() step before calling .authorize().",
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
              "Grant the principal the missing role(s) at the IdP, or relax the .authorize() requirement.",
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
              "Grant the principal the missing scope(s) at the IdP, or relax the .authorize() requirement.",
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
