import { describe, test, expect } from "bun:test";
import { isExpiredTokenError } from "../src/mcp/auth-errors.ts";

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
