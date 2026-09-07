import { resolveDatabasePath } from "./database.ts";

/**
 * Which subsystem opened which database file, per context.
 *
 * Every sqlite store versions itself through `PRAGMA user_version`, which
 * is one integer per file. Two stores pointed at one path can therefore
 * never both be satisfied: whichever opens first stamps its own version
 * and the other refuses. The stores discover that separately and late, and
 * the second one only knows that the number it found is not its own.
 *
 * Claiming the path at configuration time turns that into one error at
 * boot naming both settings, which is where a person can act on it.
 *
 * Keyed weakly by the context so a test that builds many contexts does not
 * inherit another's claims, and so nothing here outlives the context.
 */
const claims = new WeakMap<object, Map<string, string>>();

/** A path already held by a different subsystem. */
export interface SqlitePathConflict {
  /** The path as configured, before resolution, for the message. */
  readonly path: string;
  /** The subsystem that claimed it first, named as its setting. */
  readonly held: string;
  /** The subsystem claiming it now. */
  readonly claimant: string;
}

/**
 * Record that `claimant` opens the database at `path` in this context, and
 * refuse when another subsystem already opened the same file.
 *
 * `":memory:"` is exempt: each in-memory database is private to the
 * connection that opened it, so two stores asking for one never meet.
 *
 * A claimant holds at most one path, because each names one setting and a
 * setting chooses one store. Claiming a second path releases the first: an
 * unconfigured default is resolved and later replaced by the block that
 * configures it, and the path the default gave up must not go on blocking
 * another store that legitimately wants it.
 *
 * @param options.scope - The context the claim belongs to.
 * @param options.path - Database path as configured.
 * @param options.claimant - The setting that chose it, e.g.
 *   `sessions: { store }`, quoted back to the reader in the error.
 * @param options.onConflict - Builds the caller's own error, so each
 *   subsystem keeps its code. The returned error is thrown as it is.
 */
export function claimDatabasePath(options: {
  scope: object;
  path: string;
  claimant: string;
  onConflict: (conflict: SqlitePathConflict) => Error;
}): void {
  const { scope, path, claimant, onConflict } = options;
  let held = claims.get(scope);
  if (held === undefined) {
    held = new Map();
    claims.set(scope, held);
  }
  // An in-process database is private to the connection that opened it, so
  // there is nothing to claim. The claimant has still moved, though, and
  // whatever it held before must go with it.
  if (path === ":memory:") {
    releaseIn(held, claimant);
    return;
  }
  const resolved = resolveDatabasePath(path);
  const owner = held.get(resolved);
  if (owner !== undefined && owner !== claimant) {
    throw onConflict({ path, held: owner, claimant });
  }
  // Released only once the new claim is known to be good, so a refused
  // claim leaves the claimant holding what it already had.
  releaseIn(held, claimant, resolved);
  held.set(resolved, claimant);
}

/**
 * Give up whatever this claimant holds, for a store that resolved to a
 * backend with no file at all: the memory fallback, or one a caller
 * supplied. Those never reach {@link claimDatabasePath}, so without this
 * the path an earlier default claimed would go on blocking a store that
 * legitimately wants it.
 */
export function releaseClaimant(options: {
  scope: object;
  claimant: string;
}): void {
  const held = claims.get(options.scope);
  if (held !== undefined) releaseIn(held, options.claimant);
}

/** Drop every path this claimant holds, except one it is keeping. */
function releaseIn(
  held: Map<string, string>,
  claimant: string,
  keep?: string,
): void {
  for (const [path, by] of held) {
    if (by === claimant && path !== keep) held.delete(path);
  }
}
