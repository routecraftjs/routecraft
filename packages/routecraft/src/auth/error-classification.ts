import { isRoutecraftError } from "../brand.ts";

/**
 * Whether a token verification error represents an expired token.
 *
 * An expired token is a routine part of the client lifecycle: clients present a
 * stale cached token, receive a 401, then refresh and retry. Callers log it at
 * `debug` so the `warn` channel stays reserved for failures that genuinely
 * warrant attention (bad signature, wrong audience or issuer, malformed token).
 *
 * Detection keys off `jose`'s stable `ERR_JWT_EXPIRED` code, thrown by `jwks()`
 * and surfaced unchanged through userinfo enrichment, and also tagged on
 * `jwt()`'s expiry error so both built-in verifiers classify uniformly. `jose`
 * raises this code only for expiry, so audience and issuer mismatches
 * (`ERR_JWT_CLAIM_VALIDATION_FAILED`) correctly fall through. Validators that
 * reject expiry without this code also fall through to `warn`, the safe default
 * for an unclassified rejection.
 */
export function isExpiredTokenError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_JWT_EXPIRED"
  );
}

/**
 * `jose` error codes that denote a server-side failure to fetch or parse the
 * JWKS, not a problem with the presented token. `ERR_JWKS_NO_MATCHING_KEY` is
 * deliberately absent: `jose` only surfaces it after re-fetching the key set, so
 * a propagated no-matching-key means the token references an unknown signing key
 * (a token problem, 401), not an infrastructure failure.
 */
const JOSE_INFRASTRUCTURE_CODES = new Set([
  "ERR_JWKS_TIMEOUT", // JWKS endpoint did not respond within the timeout
  "ERR_JWKS_INVALID", // JWKS document was structurally invalid
  "ERR_JOSE_GENERIC", // jose's catch-all: non-200 / unparseable JWKS response
]);

/**
 * Node / undici surface a `fetch` network failure as a `TypeError` whose
 * `cause` carries the real errno. These are the codes seen when the IdP's JWKS
 * endpoint is unreachable (DNS failure, connection refused, socket timeout).
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether a token verification error is a server-side infrastructure failure
 * (JWKS endpoint unreachable, timed out, or returning a bad response) rather
 * than the verifier rejecting the presented token.
 *
 * The distinction matters for the HTTP status: an infrastructure failure must
 * map to 500 (so the client retries later), never to `401 invalid_token`, which
 * would make every client discard its valid cached token and stampede an
 * already-struggling IdP with refreshes. A token rejection is the opposite: it
 * must be 401 so the client refreshes. Callers therefore treat anything that is
 * NOT an infrastructure failure (and not a framework error) as a token
 * rejection, which keeps custom and built-in `jwt()` validators that throw a
 * plain `Error` mapping to 401.
 *
 * The whole `cause` chain is inspected, not just the immediate error: Node /
 * undici nest the real errno under a `fetch failed` TypeError, and a verifier
 * may wrap the underlying failure one or more levels deep. The walk is bounded
 * to guard against a self-referential `cause` cycle.
 */
export function isInfrastructureError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (JOSE_INFRASTRUCTURE_CODES.has(code) || NETWORK_ERROR_CODES.has(code))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Bounded vocabulary for the reasons a token-verification throw can classify
 * to. The full `auth:rejected` vocabulary is wider (`missing_header`,
 * `unsupported_scheme`, `insufficient_scope`, the api-key and signature
 * literals); this type covers only the verifier-throw classification shared by
 * the HTTP and MCP bearer paths.
 */
export type AuthRejectionReason =
  "expired" | "infrastructure" | "invalid_token";

/**
 * Map a token-verification error to the bounded `auth:rejected` reason
 * vocabulary. Never derived from the raw error message: a custom verifier
 * controls that message and could embed the bearer token, leaking a secret
 * into an aggregator-indexed event field (see `.standards/security.md`
 * sections 4 and 10). The full error stays operator-only via the structured
 * `{ err }` log binding.
 *
 * `infrastructure` mirrors the predicate the 500 mapping uses (framework
 * errors and JWKS infrastructure failures), so the event payload always
 * matches the HTTP status the client receives.
 */
export function classifyRejectionReason(err: unknown): AuthRejectionReason {
  if (isExpiredTokenError(err)) return "expired";
  if (isRoutecraftError(err) || isInfrastructureError(err)) {
    return "infrastructure";
  }
  return "invalid_token";
}

/**
 * Every code `jose` attaches to an error it throws. A closed list rather than
 * a pattern, so a custom validator's own `code` never reaches an event field.
 */
const JOSE_CODES = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_GENERIC",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWE_DECRYPTION_FAILED",
  "ERR_JWE_INVALID",
  "ERR_JWK_INVALID",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_TIMEOUT",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

/** The registered claim names (RFC 7519 section 4.1, and `typ`) a diagnosis may name. */
const DIAGNOSABLE_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "typ",
]);

/**
 * Why a verifier refused a token, in terms that are safe to index.
 *
 * `reason` on `auth:rejected` says only `invalid_token` for a bad signature,
 * a wrong issuer and a wrong audience alike, which have three different fixes.
 * This is the discriminator between them.
 */
export interface AuthRejectionDiagnosis {
  /** The `jose` error code, present only when the verifier error is one of `jose`'s. */
  code?: string;
  /** The name of the claim that failed validation. Never its value. */
  claim?: string;
  /**
   * The verifier error reduced for a log binding, present only when it is one
   * of `jose`'s. An error from a custom validator is withheld, because its
   * message is the validator's own text and could carry the bearer, and the
   * `jose` error is not passed whole, because a claim failure holds the
   * token's entire claims set as `payload`.
   */
  err?: { type: string; code: string; message: string };
}

/**
 * Read a bounded diagnosis off a token-verification error.
 *
 * `code` and `claim` come from closed lists, and `err` is built only for an
 * error carrying one of those codes, so nothing a custom validator writes into
 * its error (a message, a made-up code, a claim value) can reach an event
 * payload or a log binding through here (see `.standards/security.md` sections
 * 4 and 10). The `cause` chain is walked because userinfo enrichment and a
 * wrapping verifier nest the `jose` error, bounded against a cycle.
 *
 * @param err - What the verifier threw
 * @returns An empty object when the error is not one of `jose`'s
 */
export function diagnoseRejection(err: unknown): AuthRejectionDiagnosis {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return {};
    const { code, claim } = current as { code?: unknown; claim?: unknown };
    if (typeof code === "string" && JOSE_CODES.has(code)) {
      const { name, message } = current as {
        name?: unknown;
        message?: unknown;
      };
      return {
        code,
        ...(typeof claim === "string" && DIAGNOSABLE_CLAIMS.has(claim)
          ? { claim }
          : {}),
        err: {
          type: typeof name === "string" ? name : "Error",
          code,
          message: typeof message === "string" ? message : "",
        },
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}
