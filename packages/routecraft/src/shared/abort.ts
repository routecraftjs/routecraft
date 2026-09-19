/**
 * Composing cancellation scopes.
 *
 * A step can be cancelled by more than one owner: the route stopping, an
 * enclosing `.timeout()` expiring, a client disconnecting, a credential
 * reaching its expiry. Each site that needs the union was deciding three
 * things for itself, and the sites had already drifted on the third: filter
 * out the absent signals, avoid allocating for the single-signal case, and
 * answer what "no owner at all" means. This is the one answer.
 */

/**
 * A signal that never fires, for a composition with no owners.
 *
 * Shared rather than allocated per call: a caller holding it must see the
 * same never-aborting signal every other caller does, and an allocation per
 * request would be a controller per request that nothing ever aborts.
 */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Compose cancellation scopes into one signal.
 *
 * Absent signals are ignored, so a caller passes its optional owners
 * positionally without pre-filtering. With no present signal the result
 * never aborts, which is the honest reading of "nothing can cancel this"
 * and is what every call site previously spelled differently.
 *
 * @param signals - Cancellation owners, any of which may be absent
 * @returns The union: aborts when the first present signal aborts
 */
export function anySignal(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return NEVER_ABORTED;
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

/**
 * What {@link settleOrAbort} rejects with when the signal wins.
 *
 * A symbol rather than an error, so an abort can never be confused with
 * something the hook itself threw: every caller has to distinguish the two,
 * because they mean different things to an operator (a hook that broke
 * against one that never settled) even where they produce one code on the
 * wire.
 */
export const HOOK_ABORTED: unique symbol = Symbol("routecraft.hook.aborted");

/**
 * Run a user-supplied hook, bounded by a cancellation signal.
 *
 * The framework awaits application code in several places where an unsettled
 * hook would hold the step, and the step holds `drain()`: the resume door's
 * `authorize` and `elevate`, and the notification a `recovery.defer()`
 * directive carries. Each needs its own error code, log line and refusal
 * vocabulary, and none of them needs its own listener lifecycle, so that part
 * lives here once.
 *
 * The listener is removed on every path, including the one where the hook
 * wins the race, so bounding a hook against a long-lived route signal does
 * not accumulate listeners on it.
 *
 * @param run - The hook call, deferred so a synchronous throw inside it
 *   rejects the race rather than escaping before the bound is armed
 * @param signal - What may cut the hook short. Absent means unbounded, which
 *   is the caller's decision to make and never this function's.
 * @returns What the hook resolved with
 * @throws {@link HOOK_ABORTED} when the signal fires first, and whatever the
 *   hook threw otherwise
 */
export async function settleOrAbort<T>(
  run: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => run())(),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(HOOK_ABORTED);
          return;
        }
        onAbort = () => {
          reject(HOOK_ABORTED);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}
