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
 * This predicate is the single source of the boundary. Three checkpoints call
 * it: `authorize()` (RC5020), the HTTP bearer middleware, and
 * {@link principalExpirySignal}, which closes a stream when the credential
 * that admitted it lapses. All three pass the same `clockToleranceSec`, which
 * is what keeps them from disagreeing by a second on one credential; calling
 * this predicate while dropping its tolerance argument buys the appearance of
 * that guarantee without the substance.
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

/**
 * `setTimeout`'s ceiling: a delay past a signed 32-bit integer overflows and
 * fires on the next tick instead of waiting.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A signal that fires when a verified principal's credential expires.
 *
 * For a response that outlives the single admission check that let it in. An
 * ordinary request is over long before its token is, but a stream can be held
 * open for hours, and `security.md` makes `exp` mandatory precisely so that
 * authority does not outlive it.
 *
 * The timer only schedules the check. Whether the credential has actually
 * lapsed is {@link isPrincipalExpired}'s to say, so the boundary and its clock
 * tolerance stay the framework's single answer rather than a second comparison
 * that can drift by a second, and a timer that fires early against a skewed
 * clock re-arms instead of closing a live stream.
 *
 * Each sleep is clamped to {@link MAX_TIMEOUT_MS}. A credential expiring
 * further out than that overflows `setTimeout`, which fires immediately rather
 * than waiting: the re-arm would then spin as fast as the event loop allows,
 * for the life of the stream. Clamped, a distant expiry simply sleeps in
 * stages.
 *
 * The tolerance is the one the verification that admitted this credential
 * applied, carried on the admit verdict and passed in here. Without it a
 * client inside the tolerance window loops: admission admits, the stream arms
 * and finds the credential expired by its own stricter boundary, closes, and
 * the client reconnects into the same pair of answers.
 *
 * @param principal - The admitted principal, or undefined for an
 *   unauthenticated request
 * @param options.clockToleranceSec - Skew the admitting verification allowed
 * @param options.onExpired - Called once when the credential is found to have
 *   lapsed, for the surface to report it. Runs after the signal aborts, and
 *   a throw from it is swallowed: revocation does not depend on it
 * @returns The signal and a `cancel` to release the timer when the response
 *   ends, or `undefined` when the principal carries no expiry, since a
 *   credential that does not expire granting a stream that does not expire is
 *   the operator's own choice correctly honoured
 */
export function principalExpirySignal(
  principal: Pick<Principal, "expiresAt" | "subject"> | undefined,
  options: {
    /**
     * Required, like the field on the verdict it comes from: a default of
     * `0` here is the stricter boundary that closed a stream the door had
     * just admitted, and an optional field is how a fourth caller reaches
     * for it without noticing.
     */
    clockToleranceSec: number;
    onExpired?: (principal: Pick<Principal, "subject">) => void;
  },
): { signal: AbortSignal; cancel: () => void } | undefined {
  const expiresAt = principal?.expiresAt;
  if (principal === undefined || expiresAt === undefined) return undefined;

  const { clockToleranceSec } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (isPrincipalExpired(principal, clockToleranceSec)) {
      // Abort first, and never behind the notification: revoking the stream
      // is this function's contract and telling someone about it is a
      // courtesy, so a notifier that throws must not be able to keep an
      // expired credential's stream open.
      controller.abort(new Error("Credential expired"));
      try {
        options.onExpired?.(principal);
      } catch {
        // Swallowed rather than rethrown because there is nowhere to report
        // it: the notifier is the surface's own logger, and on the timer
        // path a throw here is an uncaught exception that takes the process
        // down over a log line.
      }
      return;
    }
    // The deadline the tolerance actually moves, not `exp` itself: sleeping
    // to `exp` inside a tolerance window would wake, find the credential
    // still good, and re-arm on the 50ms floor for the whole window.
    const remaining = (expiresAt + clockToleranceSec) * 1000 - Date.now();
    timer = setTimeout(arm, Math.min(Math.max(remaining, 50), MAX_TIMEOUT_MS));
  };
  arm();
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}
