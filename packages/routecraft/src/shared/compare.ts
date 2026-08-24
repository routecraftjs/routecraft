/**
 * Ordering primitives shared by the keyset cursors.
 *
 * Two cursors page by `(key, id)` today, the suspension store's expiry scan
 * and the management API's route collection, and both depend on the same
 * property: a strict total order that does not move between runtimes. One
 * copy so a well-meant change in either place cannot break only the other.
 */

/**
 * Code-unit comparison, deliberately not `localeCompare`: a keyset cursor
 * needs a stable strict order, and locale collation can change between
 * runtimes and between platforms running the same code.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
