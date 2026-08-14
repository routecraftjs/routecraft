#!/usr/bin/env node

/**
 * Rewrite the changelog's in-development heading to its released form.
 *
 * Runs from the root `version-packages` script after `changeset version`,
 * so it executes every time the changesets action regenerates the Version
 * Packages branch. The released heading therefore lands in the same commit
 * as the version bumps: `main` never claims a release that does not exist,
 * and nothing needs to be hand-pushed onto the generated branch (the action
 * force-pushes that branch on every green main push, so hand commits there
 * do not survive).
 *
 * Transformation, applied to the first matching heading only:
 *
 *   ## v0.6.0 <Badge color="gray">In development</Badge>
 *
 * becomes
 *
 *   ## [v0.6.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.6.0) <Badge color="yellow">Pre-release</Badge>
 *
 *   *August 2026*
 *
 * The version comes from the core package changesets just wrote, never from
 * the heading itself, so a hand-typed guess in the heading cannot leak into
 * the release. Idempotent: no in-development heading means no-op, so local
 * dry runs and repeated regenerations are safe.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const coreVersion = JSON.parse(
  readFileSync(join(rootDir, "packages", "routecraft", "package.json"), "utf8"),
).version;

if (typeof coreVersion !== "string" || coreVersion.length === 0) {
  console.error("Could not read @routecraft/routecraft version");
  process.exit(1);
}

const changelogPath = join(
  rootDir,
  "apps",
  "routecraft.dev",
  "app",
  "content",
  "changelog",
  "index.mdx",
);

let source;
try {
  source = readFileSync(changelogPath, "utf8");
} catch (error) {
  // The release cannot describe itself without this file, and a silent skip
  // would publish a version whose changelog still says "In development".
  console.error(`Could not read the changelog at ${changelogPath}`);
  throw error;
}

const inDevHeading =
  /^## v\d+\.\d+\.\d+(?:-\S+)? <Badge color="gray">In development<\/Badge>$/m;

if (!inDevHeading.test(source)) {
  console.log("Changelog has no in-development heading; nothing to finalise.");
  process.exit(0);
}

const monthLabel = new Date().toLocaleString("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const releasedHeading =
  `## [v${coreVersion}](https://github.com/routecraftjs/routecraft/releases/tag/v${coreVersion})` +
  ` <Badge color="yellow">Pre-release</Badge>\n\n*${monthLabel}*`;

writeFileSync(changelogPath, source.replace(inDevHeading, releasedHeading));

console.log(`Changelog heading finalised as v${coreVersion} (${monthLabel})`);
