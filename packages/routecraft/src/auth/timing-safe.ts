import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for a secret and a candidate presented by a caller.
 *
 * Reach for this wherever a request is admitted by comparing something it
 * carried against something the process knows: a shared secret behind a
 * custom `validator`, a signature, a digest. `===` on those returns as soon
 * as two bytes differ, and the time it took is a measurement an attacker can
 * repeat to recover the secret one byte at a time.
 *
 * Wraps `timingSafeEqual` with the explicit length guard it requires: a
 * length mismatch is an ordinary rejection, not an exception. Length itself
 * is not treated as secret; digest lengths are fixed per algorithm, so a
 * mismatch only reveals that the candidate is malformed.
 *
 * @param expected - The value the process knows
 * @param candidate - The value the caller presented
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
