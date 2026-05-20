/**
 * Whether a token verification error represents an expired token.
 *
 * An expired token is a routine part of the client lifecycle: clients present a
 * stale cached token, receive a 401, then refresh and retry. Callers log it at
 * `debug` so the `warn` channel stays reserved for failures that genuinely
 * warrant attention (bad signature, wrong audience or issuer, malformed token).
 *
 * Detection keys off `jose`'s stable `ERR_JWT_EXPIRED` code (thrown by `jwks()`
 * and surfaced unchanged through userinfo enrichment), not the message string.
 * `jose` raises this code only for expiry, so audience and issuer mismatches
 * (`ERR_JWT_CLAIM_VALIDATION_FAILED`) correctly fall through to `warn`.
 * Validators that reject expiry without this code also fall through to `warn`,
 * the safe default for an unclassified rejection.
 */
export function isExpiredTokenError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_JWT_EXPIRED"
  );
}
