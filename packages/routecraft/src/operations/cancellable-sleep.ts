/**
 * Sentinel error rejected by {@link cancellableSleep} when the supplied
 * signal aborts before the timer fires. Callers catch it to tell an
 * orderly shutdown apart from a real failure; it never escapes the
 * framework's resilience wrappers.
 *
 * @internal
 */
export class SleepAbortedError extends Error {
  constructor() {
    super("routecraft.sleep.aborted");
    this.name = "SleepAbortedError";
  }
}

/**
 * Sleep for `ms` milliseconds, rejecting early with
 * {@link SleepAbortedError} the moment `signal` aborts. The pending
 * timer is cleared on abort so a shutting-down route leaks no timers
 * and never waits out a delay or retry backoff it no longer needs.
 *
 * Shared by the resilience wrappers: `.delay()` (the wait itself),
 * `.retry()` (the backoff between attempts), and future `.throttle()`
 * (the pacing wait). Route shutdown exposes the signal via
 * `Route.signal`.
 *
 * @param ms - Milliseconds to wait
 * @param signal - Optional abort signal that cancels the wait
 * @internal
 */
export function cancellableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SleepAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SleepAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
