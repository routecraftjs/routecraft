import { isRoutecraftError } from "../brand.ts";
import {
  DIAGNOSABLE_CLAIMS,
  JOSE_CODES,
  type DiagnosableClaim,
  type JoseErrorCode,
} from "../types.ts";

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
  return (
    findInCauseChain(
      err,
      (code) =>
        JOSE_INFRASTRUCTURE_CODES.has(code) || NETWORK_ERROR_CODES.has(code),
    ) !== undefined
  );
}

/**
 * The first error in a `cause` chain, the error itself included, whose
 * `code` satisfies `match`. Bounded against a self-referential chain.
 */
function findInCauseChain(
  err: unknown,
  match: (code: string) => boolean,
): Record<string, unknown> | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    const link = current as Record<string, unknown>;
    // A verifier's error is foreign code: a getter on it may throw.
    try {
      if (typeof link["code"] === "string" && match(link["code"])) return link;
      current = link["cause"];
    } catch {
      return undefined;
    }
  }
  return undefined;
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

const isJoseCode = (code: string): code is JoseErrorCode =>
  (JOSE_CODES as readonly string[]).includes(code);

/**
 * Why a verifier refused a token, in terms that are safe to index.
 *
 * `reason` on `auth:rejected` says only `invalid_token` for a bad signature,
 * a wrong issuer and a wrong audience alike, which have three different fixes.
 * This is the discriminator between them.
 */
export interface AuthRejectionDiagnosis {
  /**
   * What an `auth:rejected` payload and a log line may carry, spread as it
   * is. Empty when the verifier error is not one of `jose`'s.
   */
  fields: {
    /** The `jose` error code. */
    code?: JoseErrorCode;
    /** The name of the claim that failed validation. Never its value. */
    claim?: DiagnosableClaim;
  };
  /**
   * The `{ err }` log binding, present only for a `jose` error and never an
   * event field. It holds the code and nothing the error itself wrote: a
   * custom validator's message could carry the bearer, a `jose` message can
   * quote the token's header, and a claim failure holds the token's whole
   * claims set as `payload`.
   */
  err?: { type: "JOSEError"; code: JoseErrorCode };
}

/**
 * Read a bounded diagnosis off a token-verification error.
 *
 * `code` and `claim` come from closed lists and nothing else is copied, so
 * nothing a custom validator or the presented token wrote (a message, a
 * made-up code, a claim value, a header parameter) can reach an event payload
 * or a log binding through here (see `.standards/security.md` sections 4 and
 * 10). The `cause` chain is walked because userinfo enrichment and a wrapping
 * verifier nest the `jose` error.
 *
 * @param err - What the verifier threw
 * @returns Empty `fields` and no `err` when the error is not one of `jose`'s
 */
export function diagnoseRejection(err: unknown): AuthRejectionDiagnosis {
  const found = findInCauseChain(err, isJoseCode);
  if (found === undefined) return { fields: {} };
  const code = found["code"] as JoseErrorCode;
  const claim = DIAGNOSABLE_CLAIMS.find((name) => name === found["claim"]);
  return {
    fields: { code, ...(claim !== undefined ? { claim } : {}) },
    err: { type: "JOSEError", code },
  };
}
