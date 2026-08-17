import type { Principal } from "./types.ts";

/**
 * Whether a verified principal's expiry has passed.
 *
 * The boundary is inclusive and floored to whole seconds, matching `jose`
 * (`exp <= now - tolerance`) and RFC 7519 section 4.1.4, which requires the
 * current time to be strictly before `exp`. A fractional `now` would put this
 * boundary up to a second ahead of the verifier's; an exclusive `>` would put
 * it a second behind and honour a token for a further second.
 *
 * Non-finite inputs fail closed: a NaN comparison is always false and would
 * silently disable the check (see `.standards/security.md` section 7).
 *
 * A principal without an `expiresAt` passes: a credential with no expiry
 * concept (an API key behind a custom validator) is a legitimate result, and
 * requiring `exp` belongs to the verifier layer (section 1), never here.
 *
 * This predicate is the single source of the boundary; `authorize()` (RC5020)
 * and the HTTP bearer middleware both call it so the two checkpoints on the
 * same credential can never disagree by a second.
 */
export function isPrincipalExpired(
  principal: Pick<Principal, "expiresAt">,
  clockToleranceSec = 0,
): boolean {
  if (principal.expiresAt === undefined) return false;
  return (
    !Number.isFinite(principal.expiresAt) ||
    !Number.isFinite(clockToleranceSec) ||
    Math.floor(Date.now() / 1000) >= principal.expiresAt + clockToleranceSec
  );
}
