/**
 * Reading the release intent out of `.changeset/*.md`.
 *
 * Two things depend on agreeing about what the next release will contain: the
 * canary job, which turns the pending bumps into the synthetic changeset it
 * publishes from, and the version-range contract test, which checks that every
 * declared range on core admits the version that release will publish. If they
 * read the front matter differently the test goes on passing while validating a
 * version nobody is cutting, so they read it here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Bump levels, weakest first. */
export const BUMP_ORDER = ["patch", "minor", "major"];

/** The higher of two bump levels. */
export function maxBump(a, b) {
  return BUMP_ORDER.indexOf(a) >= BUMP_ORDER.indexOf(b) ? a : b;
}

/**
 * The highest bump each package carries across the pending changesets, keyed by
 * package name. An empty map means no release is proposed by this tree.
 *
 * @param {string} changesetDir Absolute path to the `.changeset` directory.
 * @returns {Map<string, "patch" | "minor" | "major">}
 */
export function pendingBumps(changesetDir) {
  const bumps = new Map();
  for (const file of readdirSync(changesetDir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const text = readFileSync(join(changesetDir, file), "utf8");
    const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontMatter) continue;
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const release = line.match(
        /^\s*["']?([^"':\s]+)["']?\s*:\s*(patch|minor|major)\s*$/,
      );
      if (!release) continue;
      bumps.set(
        release[1],
        maxBump(release[2], bumps.get(release[1]) ?? "patch"),
      );
    }
  }
  return bumps;
}

/**
 * The names that version in lockstep with `name`, from the `fixed` groups in a
 * changesets config. Always includes `name` itself.
 *
 * @param {{ fixed?: string[][] }} config Parsed `.changeset/config.json`.
 * @param {string} name
 * @returns {string[]}
 */
export function fixedGroupOf(config, name) {
  return (config.fixed ?? []).find((group) => group.includes(name)) ?? [name];
}
