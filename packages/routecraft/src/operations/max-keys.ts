import { rcError } from "../error.ts";

/**
 * Default cap on distinct keys tracked by a keyed in-memory operation (the
 * `.throttle({ key })` per-key buckets, the `.dedupe()` committed-key set).
 */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * Hard ceiling on `maxKeys`. The per-key LRU pre-allocates index arrays sized
 * to its `max`, so this bounds the eager allocation a single keyed operation
 * can trigger and stops an absurd value from OOMing the process at build time.
 */
export const MAX_KEYS_CEILING = 1_000_000;

/**
 * Validate a user-supplied `maxKeys` against the shared bound, throwing
 * `RC5003` at build time so a typo fails when the route is built rather than
 * allocating an oversized index array at runtime. `op` names the operation for
 * the error message (e.g. `"throttle"`, `"dedupe"`).
 *
 * @internal
 */
export function validateMaxKeys(op: string, maxKeys: number): void {
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_KEYS_CEILING) {
    throw rcError("RC5003", undefined, {
      message: `${op}({ maxKeys }) must be an integer between 1 and ${MAX_KEYS_CEILING}, got ${String(maxKeys)}.`,
    });
  }
}
