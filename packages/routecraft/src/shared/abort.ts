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
