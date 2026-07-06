import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for two signature/digest strings.
 *
 * Wraps `timingSafeEqual` with the explicit length guard it requires: a
 * length mismatch is an ordinary rejection, not an exception. Length itself
 * is not treated as secret; digest lengths are fixed per algorithm, so a
 * mismatch only reveals that the candidate is malformed.
 *
 * Shared by the JWT HMAC validator and the webhook-signature verifier so
 * the security-critical comparison exists exactly once.
 *
 * @internal
 */
export function timingSafeStringEqual(
  expected: string,
  candidate: string,
): boolean {
  const expectedBuf = Buffer.from(expected);
  const candidateBuf = Buffer.from(candidate);
  return (
    expectedBuf.length === candidateBuf.length &&
    timingSafeEqual(expectedBuf, candidateBuf)
  );
}
