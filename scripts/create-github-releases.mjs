#!/usr/bin/env node

/**
 * Push the tags and create the GitHub Release of every package version that
 * is on npm but has no release yet, and the `v*` tag of core's version.
 *
 * The changesets action can do this itself, but when GitHub rejects one
 * release it fails the whole publish step after npm has already published,
 * and everything gated on that step (the `v*` core tag, the canary and the
 * docs deploy) is skipped. 0.7.0 went out that way. Here each release is
 * created on its own, its body cut to fit (see `lib/release-notes.mjs`), and
 * a release that still fails is reported without failing the others.
 *
 * With the action's own releases off, nothing else pushes the `name@version`
 * tags `changeset publish` creates, so this script pushes them. It runs on
 * every release job, not only on a publish: a version published without its
 * tag or release (0.7.1 did) is repaired by the next push to main. A missing
 * tag goes on the commit that set the version, since the published tree is
 * the same from there to the publish.
 *
 * Input: `PUBLISHED`, the action's `publishedPackages` output, a JSON array
 * of `{ name, version }`, may be empty or unset; every workspace package's
 * current version is checked as well. `GH_TOKEN` authenticates `gh`.
 * `DRY_RUN=1` prints what would be done instead of doing it.
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

/**
 * Whether a command exits zero.
 *
 * @param {string} cmd
 * @param {string[]} args
 */
function succeeds(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure `tag` exists on origin. A tag `changeset publish` just created is
 * pushed as it is; a missing one goes on the commit that set the version,
 * since the published tree is the same from there to the publish.
 *
 * @param {string} tag
 * @param {string} dir - The package directory whose manifest set the version
 * @param {string} version
 */
function ensureRemoteTag(tag, dir, version) {
  const ref = `refs/tags/${tag}`;
  if (succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", ref])) {
    return;
  }
  if (!succeeds("git", ["rev-parse", "--verify", "--quiet", ref])) {
    const versionCommit = execFileSync(
      "git",
      [
        "log",
        "-1",
        "--format=%H",
        `-G"version": "${version}"`,
        "--",
        `${dir}/package.json`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (dryRun) {
      console.log(`${tag}: would tag ${versionCommit || "HEAD"}`);
    } else {
      execFileSync("git", ["tag", tag, versionCommit || "HEAD"]);
    }
  }
  if (dryRun) {
    console.log(`${tag}: would push the tag`);
  } else {
    execFileSync("git", ["push", "origin", ref], { stdio: "inherit" });
  }
}

/** Every package version to check, the ones just published first. */
const candidates = new Map();
for (const { name, version } of published) {
  candidates.set(`${name}@${version}`, { name, version, justPublished: true });
}
for (const [name, dir] of packageDirs) {
  const { version, private: isPrivate } = JSON.parse(
    readFileSync(join(rootDir, dir, "package.json"), "utf8"),
  );
  const tag = `${name}@${version}`;
  if (isPrivate || candidates.has(tag)) continue;
  candidates.set(tag, { name, version, justPublished: false });
}

for (const [tag, { name, version, justPublished }] of candidates) {
  const dir = packageDirs.get(name);
  if (dir === undefined) {
    notCreated(`${tag}: no workspace package is named ${name}.`);
    continue;
  }
  // A version that never reached npm gets no tag or release: its publish failed.
  if (
    !justPublished &&
    !succeeds("npm", ["view", `${name}@${version}`, "version"])
  ) {
    continue;
  }
  try {
    // The docs freeze keys off v* tags, which mirror the core version.
    if (name === "@routecraft/routecraft") {
      ensureRemoteTag(`v${version}`, dir, version);
    }
    if (succeeds("gh", ["release", "view", tag, "--repo", repository])) {
      continue;
    }
    ensureRemoteTag(tag, dir, version);

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
    notCreated(
      `${tag} is published but its tag or GitHub Release was not created.`,
    );
  }
}

process.exit(failed === 0 ? 0 : 1);
