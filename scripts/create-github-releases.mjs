#!/usr/bin/env node

/**
 * Create one GitHub Release per package the release job just published.
 *
 * The changesets action can do this itself, but when GitHub rejects one
 * release it fails the whole publish step after npm has already published,
 * and everything gated on that step (the `v*` core tag, the canary and the
 * docs deploy) is skipped. 0.7.0 went out that way. Here each release is
 * created on its own, its body cut to fit (see `lib/release-notes.mjs`), and
 * a release that still fails is reported without failing the others.
 *
 * Input: `PUBLISHED`, the action's `publishedPackages` output, a JSON array
 * of `{ name, version }`. `GH_TOKEN` authenticates `gh`. `DRY_RUN=1` prints
 * what would be created instead of creating it.
 *
 * Exit status is non-zero when any release was not created, so the step
 * shows red; the workflow marks the step `continue-on-error` so a missing
 * release page never holds back the rest of the release.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, releaseNotes } from "./lib/release-notes.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = process.env.GITHUB_REPOSITORY ?? "routecraftjs/routecraft";
const dryRun = process.env.DRY_RUN === "1";

const published = JSON.parse(process.env.PUBLISHED ?? "[]");

/** Workspace directory of every package, keyed by package name. */
const packageDirs = new Map();
for (const entry of readdirSync(join(rootDir, "packages"))) {
  const manifest = join(rootDir, "packages", entry, "package.json");
  if (!existsSync(manifest)) continue;
  const { name } = JSON.parse(readFileSync(manifest, "utf8"));
  packageDirs.set(name, `packages/${entry}`);
}

let failed = 0;

/**
 * Report a package whose GitHub Release was not created. The title carries
 * no comma: a workflow command splits its properties on one.
 *
 * @param {string} message
 */
function notCreated(message) {
  console.log(`::warning title=GitHub Release not created::${message}`);
  failed++;
}

for (const { name, version } of published) {
  const tag = `${name}@${version}`;
  const dir = packageDirs.get(name);
  if (dir === undefined) {
    notCreated(`${tag}: no workspace package is named ${name}.`);
    continue;
  }
  try {
    const changelog = readFileSync(join(rootDir, dir, "CHANGELOG.md"), "utf8");
    const fullChangelogUrl = `https://github.com/${repository}/blob/${encodeURIComponent(tag)}/${dir}/CHANGELOG.md`;
    const section = changelogSection(changelog, version);
    const notes = releaseNotes(section, fullChangelogUrl);

    if (dryRun) {
      const cut = notes === section ? "" : ` (cut from ${section.length})`;
      console.log(`${tag}: ${notes.length} characters${cut}`);
      continue;
    }

    const args = [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--title",
      tag,
      "--notes-file",
      "-",
    ];
    // What the changesets action did: a version with a prerelease part is a
    // prerelease, so it never becomes the repository's latest release.
    if (version.includes("-")) args.push("--prerelease");
    execFileSync("gh", args, {
      input: notes,
      stdio: ["pipe", "inherit", "inherit"],
    });
    console.log(`Created the GitHub Release for ${tag}`);
  } catch {
    notCreated(`${tag} is published and tagged but has no GitHub Release.`);
  }
}

process.exit(failed === 0 ? 0 : 1);
