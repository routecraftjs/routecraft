import { describe, test, expect } from "bun:test";
import {
  isExpiredTokenError,
  isInfrastructureError,
} from "../src/mcp/auth-errors.ts";

describe("isExpiredTokenError", () => {
  /**
   * @case jose JWTExpired error (carries the ERR_JWT_EXPIRED code) is classified as expiry
   * @preconditions An Error whose `code` is "ERR_JWT_EXPIRED", as thrown by jose's jwtVerify
   * @expectedResult Returns true
   */
  test("returns true for an Error carrying the jose ERR_JWT_EXPIRED code", () => {
    const err = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: "ERR_JWT_EXPIRED",
    });
    expect(isExpiredTokenError(err)).toBe(true);
  });

  /**
   * @case Plain object carrying the ERR_JWT_EXPIRED code is classified as expiry
   * @preconditions A non-Error object with `code: "ERR_JWT_EXPIRED"`
   * @expectedResult Returns true (detection is code-based, not instanceof-based)
   */
  test("returns true for a plain object carrying the code", () => {
    expect(isExpiredTokenError({ code: "ERR_JWT_EXPIRED" })).toBe(true);
  });

  /**
   * @case A generic validation error is not classified as expiry
   * @preconditions A plain Error with no `code`
   * @expectedResult Returns false (stays on the warn channel)
   */
  test("returns false for a generic Error", () => {
    expect(isExpiredTokenError(new Error("invalid signature"))).toBe(false);
  });

  /**
   * @case An audience or issuer claim mismatch is not classified as expiry
   * @preconditions A jose claim-validation error (ERR_JWT_CLAIM_VALIDATION_FAILED)
   * @expectedResult Returns false so audience/issuer failures remain warn-worthy
   */
  test("returns false for a jose claim validation error", () => {
    const err = Object.assign(new Error('unexpected "aud" claim value'), {
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
    expect(isExpiredTokenError(err)).toBe(false);
  });

  /**
   * @case Non-object inputs are handled without throwing
   * @preconditions null, undefined, a string, and a number
   * @expectedResult Returns false for every non-object value
   */
  test("returns false for null, undefined, and primitives", () => {
    expect(isExpiredTokenError(null)).toBe(false);
    expect(isExpiredTokenError(undefined)).toBe(false);
    expect(isExpiredTokenError("ERR_JWT_EXPIRED")).toBe(false);
    expect(isExpiredTokenError(401)).toBe(false);
  });
});

describe("isInfrastructureError", () => {
  /**
   * @case A JWKS fetch timeout is classified as infrastructure
   * @preconditions A jose error carrying code "ERR_JWKS_TIMEOUT"
   * @expectedResult Returns true (maps to 500, not 401)
   */
  test("returns true for a jose JWKS timeout", () => {
    const err = Object.assign(new Error("request timed out"), {
      code: "ERR_JWKS_TIMEOUT",
    });
    expect(isInfrastructureError(err)).toBe(true);
  });

  /**
   * @case A jose generic error (non-200 / unparseable JWKS response) is infrastructure
   * @preconditions A jose error carrying code "ERR_JOSE_GENERIC"
   * @expectedResult Returns true
   */
  test("returns true for a jose generic JWKS-fetch error", () => {
    const err = Object.assign(
      new Error("Expected 200 OK from the JSON Web Key Set HTTP response"),
      { code: "ERR_JOSE_GENERIC" },
    );
    expect(isInfrastructureError(err)).toBe(true);
  });

  /**
   * @case A network failure surfaced as a TypeError with an errno cause is infrastructure
   * @preconditions A TypeError ("fetch failed") whose cause carries code "ECONNREFUSED"
   * @expectedResult Returns true (the IdP JWKS endpoint was unreachable)
   */
  test("returns true for a fetch network failure via the cause errno", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(isInfrastructureError(err)).toBe(true);
  });

  /**
   * @case Token-rejection errors are NOT classified as infrastructure
   * @preconditions jose errors for expiry, claim mismatch, signature failure, and no-matching-key
   * @expectedResult Returns false for each (these map to 401 invalid_token)
   */
  test("returns false for token-rejection jose errors", () => {
    for (const code of [
      "ERR_JWT_EXPIRED",
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JWT_INVALID",
      "ERR_JWKS_NO_MATCHING_KEY",
    ]) {
      expect(
        isInfrastructureError(Object.assign(new Error(code), { code })),
      ).toBe(false);
    }
  });

  /**
   * @case A plain validator error and non-object inputs are not infrastructure
   * @preconditions A plain Error with no code, plus null/undefined/string
   * @expectedResult Returns false (default to a token rejection / safe handling)
   */
  test("returns false for a plain error and non-object inputs", () => {
    expect(isInfrastructureError(new Error("invalid token"))).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
    expect(isInfrastructureError(undefined)).toBe(false);
    expect(isInfrastructureError("ERR_JWKS_TIMEOUT")).toBe(false);
  });
});
