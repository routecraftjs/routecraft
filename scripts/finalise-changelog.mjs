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
 *   ## v0.6.0 {% badge color="gray" %}In development{% /badge %}
 *
 * becomes
 *
 *   ## [v0.6.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.6.0) {% badge color="yellow" %}Pre-release{% /badge %}
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
  "src",
  "app",
  "changelog",
  "page.md",
);

const source = readFileSync(changelogPath, "utf8");

const inDevHeading =
  /^## v\d+\.\d+\.\d+(?:-\S+)? \{% badge color="gray" %\}In development\{% \/badge %\}$/m;

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
  ` {% badge color="yellow" %}Pre-release{% /badge %}\n\n*${monthLabel}*`;

writeFileSync(changelogPath, source.replace(inDevHeading, releasedHeading));

console.log(`Changelog heading finalised as v${coreVersion} (${monthLabel})`);
