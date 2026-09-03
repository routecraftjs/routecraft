#!/usr/bin/env node

/**
 * Prepare the synthetic changeset for the publish-canary job.
 *
 * Scopes the canary snapshot to the packages the push actually changed,
 * while keeping the version line aimed at the next stable release:
 *
 * 1. Diffs `<base-sha>..HEAD` to find the changed public packages.
 * 2. Collects the highest pending bump per package from the changesets on
 *    main, then deletes them: they belong to the next stable release, and
 *    `changeset version --snapshot` would otherwise consume them and pull
 *    every package they mention into every canary.
 * 3. Expands `fixed` groups from .changeset/config.json so the core train
 *    moves together whenever any member changed.
 * 4. Folds in any public package the registry is behind on: one whose
 *    current version is absent (`changeset publish` publishes every locally
 *    unpublished version, snapshot-bumped or not, so a never-released stable
 *    version would otherwise leak onto npm from the canary job), and one
 *    whose newest canary was cut from a commit that predates a change to it.
 *    The second rule is what makes a missed canary self-healing: scoping to
 *    a single push means a failed canary job drops that push's packages for
 *    good, since no later push has them in its diff range.
 *    Nothing kept after all four steps means no canary (`publish=false`).
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

import { pendingBumps as readPendingBumps } from "./lib/changeset-bumps.mjs";

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

// 2. Record the highest pending bump per package, then drop the pending
// changesets so only the synthetic one below drives the snapshot.
const pendingBump = readPendingBumps(changesetDir);
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith(".md") || file === "README.md") continue;
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

/**
 * Fetch JSON from the npm registry. A 404 resolves to null so a package that
 * has never been published reads as absent rather than an error.
 */
async function registryJson(path, accept) {
  let res;
  try {
    res = await fetch(`https://registry.npmjs.org/${path}`, {
      headers: accept ? { accept } : {},
      // Fail loudly instead of letting a stalled connection hang the job.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`npm registry lookup failed for ${path}`, { cause: err });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${path}`);
  }
  return await res.json();
}

/**
 * The commit the package's newest canary was built from, or null when that
 * cannot be established. npm records `gitHead` on publish, so the published
 * canary carries its own base and no state has to be kept on our side.
 */
async function publishedCanaryBase(name, meta) {
  const version = meta["dist-tags"]?.canary;
  if (!version) return null;
  const manifest = await registryJson(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  const sha = manifest?.gitHead;
  if (typeof sha !== "string" || !sha) return null;
  // A shallow or rewritten history cannot resolve it; treat as unknown.
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: rootDir,
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  return sha;
}

function changedSince(sha, dir) {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", sha, "HEAD", "--", `packages/${dir}/`],
    { cwd: rootDir, encoding: "utf8" },
  );
  return out.trim().length > 0;
}

// 4. Fold in public packages the registry is behind on: never-published
// versions, and packages changed since their newest canary was cut.
for (const [name, pkg] of packages) {
  if (keep.has(name)) continue;
  const meta = await registryJson(
    encodeURIComponent(name),
    "application/vnd.npm.install-v1+json",
  );
  if (!meta?.versions?.[pkg.version]) {
    console.log(
      `${name}@${pkg.version} is not on npm; folding it into the canary.`,
    );
    keep.add(name);
    continue;
  }
  const canaryBase = await publishedCanaryBase(name, meta);
  if (canaryBase === null) {
    console.log(
      `${name} has no resolvable canary base; folding it into the canary.`,
    );
    keep.add(name);
    continue;
  }
  if (changedSince(canaryBase, pkg.dir)) {
    console.log(
      `${name} changed since its canary at ${canaryBase.slice(0, 7)}; folding it into the canary.`,
    );
    keep.add(name);
  }
}
expandFixedGroups();

if (keep.size === 0) {
  console.log("Registry is level with main; skipping canary.");
  setOutput("publish=false");
  process.exit(0);
}

// 5. Write the synthetic changeset, carrying the pending bump intent.
const releases = [...keep]
  .sort()
  .map((name) => `"${name}": ${pendingBump.get(name) ?? "patch"}`);
const snapshotPath = join(changesetDir, "snapshot-canary.md");
writeFileSync(
  snapshotPath,
  `---\n${releases.join("\n")}\n---\n\nCanary snapshot of the packages this push changed, plus any the registry was behind on.\n`,
);
console.log(readFileSync(snapshotPath, "utf8"));
setOutput("publish=true");
