import type { Principal } from "../auth/types.ts";
import type { PrincipalRef } from "./types.ts";

/**
 * Reduce a live principal to the audit reference a suspension records.
 *
 * A subset, not the principal itself: a full principal carries claims,
 * scopes and a delegation chain that would be resurrected as data with no
 * verification behind it. What the record answers is "who authorized
 * this", which is what a receipt is for.
 *
 * It lives next to {@link PrincipalRef} rather than in the resume
 * operation because the reduction IS the type's contract. The next writer
 * of a `PrincipalRef` (an operator deny path, a cancellation) has to
 * record the same subset, and a second hand-rolled projection is how a
 * scope or a claims bag ends up in the store.
 *
 * @internal
 */
export function principalRef(principal: Principal): PrincipalRef {
  return {
    subject: principal.subject,
    ...(principal.issuer !== undefined ? { issuer: principal.issuer } : {}),
    ...(principal.clientId !== undefined
      ? { clientId: principal.clientId }
      : {}),
    ...(principal.actor?.subject !== undefined
      ? { actorSubject: principal.actor.subject }
      : {}),
  };
}
