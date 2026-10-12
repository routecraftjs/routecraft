/**
 * The keep-set rules `prepare-canary-snapshot.mjs` applies before it writes
 * the synthetic changeset. Pure so the selection can be tested without git,
 * the registry or a changeset directory; the script supplies those inputs.
 *
 * `published` is anything with `has(name)`: the public workspace packages,
 * so a name a changeset mentions that is private or gone is never kept.
 */

/** The package whose build pins every other `@routecraft/*` package. */
export const SCAFFOLDER = "create-routecraft";

/**
 * Pull a whole `fixed` group in whenever any member is kept, so the core
 * train snapshots together. Mutates and returns `keep`.
 *
 * @param {Set<string>} keep
 * @param {string[][] | undefined} fixed `config.fixed` from `.changeset/config.json`
 * @param {{ has(name: string): boolean }} published
 * @returns {Set<string>}
 */
export function expandFixedGroups(keep, fixed, published) {
  for (const group of fixed ?? []) {
    if (!group.some((name) => keep.has(name))) continue;
    for (const name of group) {
      if (published.has(name)) keep.add(name);
    }
  }
  return keep;
}

/**
 * When the scaffolder is in the snapshot, keep every package with a pending
 * bump, then expand fixed groups again for any train member that brought in.
 *
 * The scaffolder pins each `@routecraft/*` package at its version in this
 * snapshot, so one left out would scaffold at its last stable release: the
 * code the pending release replaces, beside a core that has moved on. It
 * runs only when the scaffolder is already kept, which is every canary of
 * the core train, and never starts a canary by itself.
 *
 * @param {Set<string>} keep
 * @param {Map<string, string>} pendingBump package name to its highest pending bump
 * @param {{ has(name: string): boolean }} published
 * @param {string[][] | undefined} fixed
 * @returns {string[]} the names it folded in, for the job log
 */
export function foldPendingForScaffolder(keep, pendingBump, published, fixed) {
  if (!keep.has(SCAFFOLDER)) return [];
  const folded = [];
  for (const name of pendingBump.keys()) {
    if (published.has(name) && !keep.has(name)) {
      keep.add(name);
      folded.push(name);
    }
  }
  expandFixedGroups(keep, fixed, published);
  return folded;
}
