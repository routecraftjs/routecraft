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
 *
 * The section's documentation links move channel at the same moment. While a
 * section is in development it links to `/docs/next`, because `/docs` serves
 * the frozen released tag and the pages it describes are not in it yet; the
 * release is what puts them there, so the links become `/docs` here. Only the
 * section being released is touched, so older sections keep pointing at the
 * released channel and a later `/docs/next` link in an unreleased section
 * below is left for its own release to move.
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

// Core did not bump in this run: `ai` and `os` sit outside the fixed train,
// so a release of one of them alone reaches here with the core version
// unchanged. Finalising then would date the in-development section to a
// version that already shipped, giving the changelog two headings for one
// release, and would move its links to a channel that release does not
// refreeze. The section belongs to the next CORE release; anything else
// leaves it alone.
if (source.includes(`## [v${coreVersion}](`)) {
  console.log(
    `Core is still v${coreVersion}, which the changelog already records as ` +
      `released; leaving the in-development section for the next core release.`,
  );
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

const withHeading = source.replace(inDevHeading, releasedHeading);

// Bounded to the released section: from its heading to the next one, or to
// the end when it is the only section. A repository-wide replace would drag
// links in sections that are still unreleased onto a channel that does not
// document them.
const headingIndex = withHeading.search(
  /^## \[v\d+\.\d+\.\d+(?:-\S+)?\]\(https:\/\/github\.com/m,
);
const afterHeading = withHeading.indexOf("\n", headingIndex);
const nextHeading = withHeading.indexOf("\n## ", afterHeading);
const sectionEnd = nextHeading === -1 ? withHeading.length : nextHeading;

const section = withHeading.slice(headingIndex, sectionEnd);
const released = section.replaceAll("](/docs/next/", "](/docs/");
const movedLinks = section.split("](/docs/next/").length - 1;

writeFileSync(
  changelogPath,
  withHeading.slice(0, headingIndex) + released + withHeading.slice(sectionEnd),
);

console.log(
  `Changelog heading finalised as v${coreVersion} (${monthLabel}); ` +
    `${movedLinks} documentation link(s) moved to the released channel`,
);
