#!/usr/bin/env node

/**
 * Prepare the synthetic changeset for the publish-canary job.
 *
 * Scopes the canary snapshot to the packages the push actually changed,
 * while keeping the version line aimed at the next stable release:
 *
 * 1. Diffs `<base-sha>..HEAD` to find the changed public packages. No
 *    public package changed means no canary (`publish=false`).
 * 2. Collects the highest pending bump per package from the changesets on
 *    main, then deletes them: they belong to the next stable release, and
 *    `changeset version --snapshot` would otherwise consume them and pull
 *    every package they mention into every canary.
 * 3. Expands `fixed` groups from .changeset/config.json so the core train
 *    moves together whenever any member changed.
 * 4. Folds in any public package whose current version is absent from the
 *    npm registry: `changeset publish` publishes every locally unpublished
 *    version, snapshot-bumped or not, so a never-released stable version
 *    would otherwise leak onto npm from the canary job.
 * 5. Writes .changeset/snapshot-canary.md giving each kept package its
 *    pending bump (patch when none), so canaries keep previewing the next
 *    stable version (e.g. 0.6.0-canary-<datetime> while a minor is
 *    pending, not 0.5.1-canary-<datetime>).
 *
 * Usage: node scripts/prepare-canary-snapshot.mjs <base-sha>
 *
 * Writes `publish=true|false` to $GITHUB_OUTPUT when set.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = join(rootDir, ".changeset");

const base = process.argv[2];
if (!base) {
  console.error("Usage: prepare-canary-snapshot.mjs <base-sha>");
  process.exit(1);
}

function setOutput(line) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
}

const BUMP_ORDER = ["patch", "minor", "major"];
function maxBump(a, b) {
  return BUMP_ORDER.indexOf(a) >= BUMP_ORDER.indexOf(b) ? a : b;
}

// Public workspace packages, keyed by name.
const packages = new Map();
for (const dir of readdirSync(join(rootDir, "packages"))) {
  const manifestPath = join(rootDir, "packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) continue;
  packages.set(manifest.name, { dir, version: manifest.version });
}

// 1. Public packages changed by this push.
const diff = execFileSync(
  "git",
  ["diff", "--name-only", base, "HEAD", "--", "packages/"],
  { cwd: rootDir, encoding: "utf8" },
);
const changedDirs = new Set(
  diff
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("/")[1]),
);
const keep = new Set(
  [...packages]
    .filter(([, pkg]) => changedDirs.has(pkg.dir))
    .map(([name]) => name),
);

if (keep.size === 0) {
  console.log("No public package changed; skipping canary.");
  setOutput("publish=false");
  process.exit(0);
}

// 2. Record the highest pending bump per package, then drop the pending
// changesets so only the synthetic one below drives the snapshot.
const pendingBump = new Map();
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith(".md") || file === "README.md") continue;
  const text = readFileSync(join(changesetDir, file), "utf8");
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontMatter) {
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const release = line.match(
        /^\s*["']?([^"':\s]+)["']?\s*:\s*(patch|minor|major)\s*$/,
      );
      if (release) {
        pendingBump.set(
          release[1],
          maxBump(release[2], pendingBump.get(release[1]) ?? "patch"),
        );
      }
    }
  }
  unlinkSync(join(changesetDir, file));
}

// 3. Any fixed-group member in the keep set pulls in the whole group, so
// the train snapshots together and carries its pending bump intent.
const config = JSON.parse(
  readFileSync(join(changesetDir, "config.json"), "utf8"),
);
function expandFixedGroups() {
  for (const group of config.fixed ?? []) {
    if (!group.some((name) => keep.has(name))) continue;
    for (const name of group) {
      if (packages.has(name)) keep.add(name);
    }
  }
}
expandFixedGroups();

// 4. Fold in public packages whose current version was never published.
for (const [name, pkg] of packages) {
  if (keep.has(name)) continue;
  const res = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    { headers: { accept: "application/vnd.npm.install-v1+json" } },
  );
  if (res.status !== 404) {
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status} for ${name}`);
    }
    const meta = await res.json();
    if (meta.versions?.[pkg.version]) continue;
  }
  console.log(
    `${name}@${pkg.version} is not on npm; folding it into the canary.`,
  );
  keep.add(name);
}
expandFixedGroups();

// 5. Write the synthetic changeset, carrying the pending bump intent.
const releases = [...keep]
  .sort()
  .map((name) => `"${name}": ${pendingBump.get(name) ?? "patch"}`);
const snapshotPath = join(changesetDir, "snapshot-canary.md");
writeFileSync(
  snapshotPath,
  `---\n${releases.join("\n")}\n---\n\nCanary snapshot of the packages changed in this push.\n`,
);
console.log(readFileSync(snapshotPath, "utf8"));
setOutput("publish=true");
