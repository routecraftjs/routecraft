import { describe, expect, test } from "bun:test";

import {
  isPrincipalExpired,
  principalExpirySignal,
} from "../../src/auth/expiry.ts";

/**
 * The expiry boundary and the signal that closes a stream on it.
 *
 * The property under test is agreement: three checkpoints look at one
 * credential, and a checkpoint that applies a stricter boundary than the one
 * that admitted the credential produces a loop rather than a refusal, since
 * the client reconnects, is admitted again, and is closed again.
 */

/** A principal whose credential lapsed `secondsAgo` seconds ago. */
function lapsed(secondsAgo: number): { expiresAt: number; subject: string } {
  return {
    expiresAt: Math.floor(Date.now() / 1000) - secondsAgo,
    subject: "operator",
  };
}

/** Let the event loop run the timer callbacks that are already due. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("principalExpirySignal", () => {
  /**
   * @case A credential inside the admitting tolerance is left alone
   * @preconditions A principal five seconds past exp, armed with the sixty second tolerance that admitted it
   * @expectedResult The signal is not aborted, because the checkpoint that closes a stream must apply the boundary that opened it
   */
  test("honours the tolerance that admitted the credential", () => {
    const expiry = principalExpirySignal(lapsed(5), { clockToleranceSec: 60 });

    expect(expiry?.signal.aborted).toBe(false);
    expiry?.cancel();
  });

  /**
   * @case The same credential without a tolerance closes at once
   * @preconditions The same principal, armed with no tolerance
   * @expectedResult Aborted on arm. This is the disagreement the tolerance exists to remove, asserted directly so the pair reads as one fact
   */
  test("closes the same credential when no tolerance is given", () => {
    const expiry = principalExpirySignal(lapsed(5), { clockToleranceSec: 0 });

    expect(expiry?.signal.aborted).toBe(true);
  });

  /**
   * @case The timer wakes on the deadline the tolerance moved, not on exp
   * @preconditions A principal exactly at exp, armed with a tolerance of one second
   * @expectedResult Open immediately and closed once the window passes. Sleeping to `exp` would wake inside the window, find the credential good, and re-arm on the fifty millisecond floor for the rest of it
   */
  test("closes once the tolerance window itself passes", async () => {
    const expiry = principalExpirySignal(lapsed(0), { clockToleranceSec: 1 });
    expect(expiry?.signal.aborted).toBe(false);

    await settle(1_300);

    expect(expiry?.signal.aborted).toBe(true);
    expiry?.cancel();
  });

  /**
   * @case The surface is told before the signal aborts
   * @preconditions An already lapsed principal with an onExpired callback
   * @expectedResult The callback receives the subject, so a surface can log which credential closed its stream without reaching for the credential itself
   */
  test("reports the subject before aborting", () => {
    const seen: string[] = [];

    const expiry = principalExpirySignal(lapsed(10), {
      clockToleranceSec: 0,
      onExpired: ({ subject }) => seen.push(subject),
    });

    expect(seen).toEqual(["operator"]);
    expect(expiry?.signal.aborted).toBe(true);
  });

  /**
   * @case A credential with no expiry gets no signal at all
   * @preconditions A principal carrying no expiresAt, and no principal at all
   * @expectedResult Undefined in both cases: a credential that does not expire granting a stream that does not expire is the operator's choice honoured, not a gap
   */
  test("returns nothing to arm when there is no expiry", () => {
    expect(
      principalExpirySignal({ subject: "operator" }, { clockToleranceSec: 0 }),
    ).toBeUndefined();
    expect(
      principalExpirySignal(undefined, { clockToleranceSec: 0 }),
    ).toBeUndefined();
  });

  /**
   * @case The predicate and the signal agree on the same inputs
   * @preconditions One principal and one tolerance, put to both the predicate and the signal
   * @expectedResult The signal's armed state matches the predicate's answer at each of the three positions around the boundary, which is what "single source of the boundary" has to mean in practice
   */
  test("arms exactly when the predicate says expired", () => {
    for (const [secondsAgo, tolerance] of [
      [5, 60],
      [5, 0],
      [120, 60],
    ] as const) {
      const principal = lapsed(secondsAgo);
      const expiry = principalExpirySignal(principal, {
        clockToleranceSec: tolerance,
      });

      expect(expiry?.signal.aborted).toBe(
        isPrincipalExpired(principal, tolerance),
      );
      expiry?.cancel();
    }
  });
});
