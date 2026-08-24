/**
 * Admission to a management tier.
 *
 * Two decisions, kept apart on purpose. The mount's `auth` (its own, or the
 * named server's, per the server plugin's inheritance) decides WHO the
 * caller is. The tier's own value decides what that identity must carry.
 * One validator serves every tier; only the requirement differs, which is
 * what makes "this token may read routes but may not dispatch" a rule an
 * operator can also enforce at a proxy.
 */

import { missingScopes } from "../../auth/authorize";
import type { Principal } from "../../auth/types";
import type { HttpMountContext } from "../server/types";
import type { OpsTier, OpsTiers } from "./types";

/**
 * What admission decided. Transport-neutral apart from the `rejected` arm,
 * which passes the auth middleware's own canonical response through: that
 * response carries the 401-versus-500 classification the security standard
 * requires (an unreachable JWKS is a server fault, never a bad credential),
 * and re-deriving it here would be a second place for that to drift.
 */
export type TierVerdict =
  | { kind: "disabled" }
  | { kind: "admit"; principal?: Principal }
  | { kind: "unauthenticated"; scheme: string }
  | { kind: "rejected"; response: Response }
  | { kind: "insufficient"; missing: string; scheme: string };

/**
 * Decide whether this request may act on a tier.
 *
 * On an open (`true`) tier a presented credential is still resolved, so a
 * dispatch carries the real principal into the route rather than running
 * anonymously just because the tier asked for nothing. A credential that
 * fails there leaves the caller anonymous rather than refused, matching the
 * rule already applied to an opted-out mcp mount: on a surface with no wall,
 * presenting a credential must never leave a caller worse off than silence.
 *
 * On a scope-gated tier the scope check is exact membership against
 * `principal.scopes`, the same comparison `authorize()` makes, so an
 * operator reasons about one scope model rather than two.
 */
export async function admitToTier(
  tier: OpsTier | undefined,
  context: HttpMountContext,
): Promise<TierVerdict> {
  if (tier === undefined || tier === false) return { kind: "disabled" };

  if (tier === true) {
    if (!context.auth.configured) return { kind: "admit" };
    const result = await context.authenticate();
    return result?.kind === "admit"
      ? { kind: "admit", principal: result.principal }
      : { kind: "admit" };
  }

  const result = await context.authenticate();
  if (!result) {
    // Unreachable: a scope-gated tier with no validator in scope fails the
    // boot. Kept as an explicit refusal so a future gap fails closed rather
    // than admitting every caller to a tier that asked for a scope.
    return { kind: "unauthenticated", scheme: "bearer" };
  }
  if (result.kind === "absent") {
    return { kind: "unauthenticated", scheme: result.scheme };
  }
  if (result.kind === "reject")
    return { kind: "rejected", response: result.response };

  if (missingScopes(result.principal, [tier]).length > 0) {
    // The scheme rides along because the refusal carries a challenge, and a
    // challenge naming the wrong scheme tells an api-key client to go and
    // get a bearer token it has no way to obtain.
    return {
      kind: "insufficient",
      missing: tier,
      scheme: result.principal.scheme,
    };
  }
  return { kind: "admit", principal: result.principal };
}

/** Whether any tier is scope-gated, and so actually enforces a wall. */
export function enforcesWall(tiers: OpsTiers): boolean {
  return Object.values(tiers).some((value) => typeof value === "string");
}
