#!/usr/bin/env node

/**
 * Finish a release on GitHub: the tags and the GitHub Release of every
 * package version that is on npm but lacks them.
 *
 * The changesets action can create releases itself, but when GitHub rejects
 * one it fails the whole publish step after npm has already published, and
 * everything after that step is skipped. 0.7.0 went out that way. With the
 * action's releases off, nothing else pushes the `name@version` tags
 * `changeset publish` creates, so this script does, together with the `v*`
 * tag the docs freeze reads.
 *
 * Two modes, run as two steps because they fail differently:
 * - `tags`: pushes the package tags and core's `v*` tag. A failure exits
 *   non-zero and fails the release job, so the docs never freeze to a stale
 *   tag; re-running the job finishes it.
 * - `releases`: creates the missing GitHub Releases, each on its own with its
 *   body cut to fit (see `lib/release-notes.mjs`). A failure is a warning and
 *   never holds back the canary or the docs deploy.
 *
 * Both check every workspace package's current version as well as the ones
 * just published, so a version whose tags or Release were never made is
 * finished by the next green push to main.
 *
 * Input: `PUBLISHED`, the action's `publishedPackages` output, a JSON array
 * of `{ name, version }`. `GH_TOKEN` authenticates `gh`. `DRY_RUN=1` prints
 * what would be done instead of doing it.
 *
 * Usage: node scripts/create-github-releases.mjs <tags|releases>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedVersion } from "./lib/npm-registry.mjs";
import { changelogSection, releaseNotes } from "./lib/release-notes.mjs";

const mode = process.argv[2];
if (mode !== "tags" && mode !== "releases") {
  console.error(
    "Usage: node scripts/create-github-releases.mjs <tags|releases>",
  );
  process.exit(2);
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = process.env.GITHUB_REPOSITORY ?? "routecraftjs/routecraft";
const dryRun = process.env.DRY_RUN === "1";
const published = JSON.parse(process.env.PUBLISHED || "[]");

/** Every workspace package, keyed by name. */
const packages = new Map();
for (const entry of readdirSync(join(rootDir, "packages"))) {
  const manifest = join(rootDir, "packages", entry, "package.json");
  if (!existsSync(manifest)) continue;
  const {
    name,
    version,
    private: isPrivate,
  } = JSON.parse(readFileSync(manifest, "utf8"));
  packages.set(name, { dir: `packages/${entry}`, version, isPrivate });
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
 * The commit a published version came from: npm's recorded `gitHead`, else
 * the last commit that set the version in the package's manifest. Null when
 * neither is in this history, so a tag is never guessed onto the wrong tree.
 *
 * @param {string} dir
 * @param {string} version
 * @param {string | undefined} gitHead
 */
function publishedCommit(dir, version, gitHead) {
  if (gitHead && succeeds("git", ["cat-file", "-e", `${gitHead}^{commit}`])) {
    return gitHead;
  }
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
  return versionCommit || null;
}

/**
 * Push `tag` to origin unless it is there. A tag `changeset publish` just
 * created locally is pushed as it is; a missing one is created first.
 *
 * @param {string} tag
 * @param {() => string | null} commit - Resolves the commit to tag
 */
function ensureRemoteTag(tag, commit) {
  const ref = `refs/tags/${tag}`;
  if (succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", ref])) {
    return;
  }
  if (!succeeds("git", ["rev-parse", "--verify", "--quiet", ref])) {
    const sha = commit();
    if (!sha) throw new Error(`no commit found to tag ${tag} on`);
    if (dryRun) console.log(`${tag}: would tag ${sha}`);
    else execFileSync("git", ["tag", tag, sha]);
  }
  if (dryRun) console.log(`${tag}: would push the tag`);
  else execFileSync("git", ["push", "origin", ref], { stdio: "inherit" });
}

/**
 * Create the GitHub Release of `tag` unless it exists.
 *
 * @param {string} tag
 * @param {string} dir
 * @param {string} version
 */
function ensureRelease(tag, dir, version) {
  if (succeeds("gh", ["release", "view", tag, "--repo", repository])) return;
  const changelog = readFileSync(join(rootDir, dir, "CHANGELOG.md"), "utf8");
  const fullChangelogUrl = `https://github.com/${repository}/blob/${encodeURIComponent(tag)}/${dir}/CHANGELOG.md`;
  const section = changelogSection(changelog, version);
  const notes = releaseNotes(section, fullChangelogUrl);

  if (dryRun) {
    const cut = notes === section ? "" : ` (cut from ${section.length})`;
    console.log(
      `${tag}: would create a Release, ${notes.length} characters${cut}`,
    );
    return;
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
}

/** Every package version to check, the ones just published first. */
const candidates = new Map();
for (const { name, version } of published) {
  candidates.set(`${name}@${version}`, { name, version, justPublished: true });
}
for (const [name, { version, isPrivate }] of packages) {
  const tag = `${name}@${version}`;
  if (!isPrivate && !candidates.has(tag)) {
    candidates.set(tag, { name, version, justPublished: false });
  }
}

let failed = 0;

for (const [tag, { name, version, justPublished }] of candidates) {
  const pkg = packages.get(name);
  try {
    if (pkg === undefined)
      throw new Error(`no workspace package is named ${name}`);
    // Null means never published, so there is nothing to finish. A version
    // published moments ago may not be readable yet; its local tag stands in.
    const manifest = await publishedVersion(name, version);
    if (manifest === null && !justPublished) continue;
    const commit = () => publishedCommit(pkg.dir, version, manifest?.gitHead);

    if (mode === "tags") {
      ensureRemoteTag(tag, commit);
      // The docs freeze keys off v* tags, which mirror the core version.
      if (name === "@routecraft/routecraft")
        ensureRemoteTag(`v${version}`, commit);
    } else {
      ensureRelease(tag, pkg.dir, version);
    }
  } catch (err) {
    failed++;
    // The title carries no comma: a workflow command splits its properties on one.
    const title =
      mode === "tags" ? "Release tag not pushed" : "GitHub Release not created";
    console.log(
      `::${mode === "tags" ? "error" : "warning"} title=${title}::${tag}: ${err.message}`,
    );
  }
}

process.exit(failed === 0 ? 0 : 1);
