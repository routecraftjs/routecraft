import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import semver from "semver";

import {
  fixedGroupOf,
  maxBump,
  pendingBumps,
} from "../../../scripts/lib/changeset-bumps.mjs";

/**
 * Guards the compatibility contract described in `.standards/ci-cd.md`
 * section 5: every workspace manifest's declared range on
 * `@routecraft/routecraft` must admit the version that governs it. Which
 * version that is depends on the field, because the two are resolved and
 * rewritten by different machinery.
 *
 * A **peer** range is never used for local resolution (an ecosystem package
 * reaches the in-tree core through its `workspace:*` devDependency) and
 * changesets only rewrites it when it is OUT of range, so it must admit the
 * version the next release publishes, in both its stable form and its canary
 * prerelease form. A peer that refuses the version being published is
 * rewritten to that exact snapshot version, which only holds inside the batch
 * that produced it; `@routecraft/ai` and `@routecraft/os` publish in their own
 * batches, so the pin dangles and a downstream install of both at the `canary`
 * tag resolves a second copy of core, whose `Exchange` and `StoreRegistry`
 * types are structurally distinct from the first.
 *
 * A **regular** range is the opposite case: `bun install` resolves it against
 * the workspace, so it must admit the workspace's CURRENT version or the
 * package silently links a published copy of core instead of the in-tree one.
 * Changesets rewrites these on every release rather than only when they leave
 * the range, so what they name never reaches npm stale, and requiring them to
 * admit the next version too would be requiring the resolution regression.
 *
 * `-0` is what admits a prerelease, and it only admits prereleases on the same
 * `major.minor.patch` as the comparator carrying it: `>=0.6.0-0` still refuses
 * `0.7.0-canary-*`. So a peer range's lower bound has to move with the line,
 * and this test is what fails when it has not.
 *
 * The bump intent is read through `scripts/lib/changeset-bumps.mjs`, the same
 * module `scripts/prepare-canary-snapshot.mjs` uses, because this check only
 * describes what that script will publish for as long as the two agree about
 * the front matter. Range satisfaction is asked of `semver` rather than
 * `Bun.semver` for the same reason: node-semver is the engine changesets
 * itself uses to decide whether a declared range is out of range.
 *
 * The canary form is only asserted while a release is actually proposed. A
 * tree with no pending changesets (a "Version Packages" branch, or main
 * straight after a release) has no next version anyone has asked for, and no
 * static range can admit the prerelease of a version that has not been
 * proposed: `>=0.7.0-0` refuses `0.7.1-canary-*`, so asserting it there would
 * fail the release PR itself and demand an edit against a version nobody has
 * chosen yet. The obligation lands on the change that proposes the next
 * version, which is the change that can satisfy it.
 */

const REPO_ROOT = join(import.meta.dir, "../../..");
const CORE = "@routecraft/routecraft";

/**
 * Manifest fields carrying a range on core, and whether `bun install`
 * resolves that range locally. A locally resolved field is held to the
 * workspace's current version; the rest to the next published one.
 */
const RANGE_FIELDS = {
  dependencies: "local",
  optionalDependencies: "local",
  peerDependencies: "published",
} as const;

/**
 * Range protocols that never reach npm: bun resolves them to the in-tree
 * package, and changesets replaces them at publish.
 */
const LOCAL_PROTOCOLS = ["workspace:", "link:", "file:", "portal:", "catalog:"];

/** Stand-in canary suffix; `snapshot.prereleaseTemplate` is `{tag}-{datetime}`. */
const SAMPLE_CANARY_SUFFIX = "canary-20260830132156";

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[];
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/**
 * Every workspace manifest, resolved from the root `workspaces` globs. Only
 * the `dir/*` and plain-directory forms are used in this repo; anything else
 * is reported rather than skipped, so a new glob shape cannot quietly drop
 * packages out of the check.
 */
function workspaceManifestPaths(): string[] {
  const root = readManifest(join(REPO_ROOT, "package.json"));
  const paths: string[] = [join(REPO_ROOT, "package.json")];
  for (const pattern of root.workspaces ?? []) {
    if (pattern.includes("*")) {
      const parent = dirname(pattern);
      if (parent.includes("*")) {
        throw new Error(`Unsupported workspace glob: ${pattern}`);
      }
      const parentDir = join(REPO_ROOT, parent);
      if (!existsSync(parentDir)) continue;
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = join(parentDir, entry.name, "package.json");
        if (existsSync(manifest)) paths.push(manifest);
      }
    } else {
      const manifest = join(REPO_ROOT, pattern, "package.json");
      if (existsSync(manifest)) paths.push(manifest);
    }
  }
  return paths;
}

/**
 * The version a release cut from this tree would publish for core, and whether
 * any changeset actually proposes it.
 *
 * The manifest holds the last released version (`.standards/ci-cd.md` section
 * 9), so the next one is that version plus the highest bump any member of
 * core's fixed group carries. With nothing pending the canary job's synthetic
 * changeset falls back to a patch, which is the version named here, but
 * `proposed` is false because no change in the tree asked for it.
 *
 * Returns null on a tree whose version is already a prerelease. That is a
 * `changeset version --snapshot` working tree, where the ranges have been
 * rewritten for the snapshot already and there is nothing left to assert; a
 * throw there would report a manifest defect for a version the release step
 * wrote seconds earlier.
 */
function nextCoreRelease(
  current: string | undefined,
  changesetDir: string,
): { version: string; proposed: boolean } | null {
  const parts = current?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) {
    if (current !== undefined && semver.prerelease(current) !== null) {
      return null;
    }
    throw new Error(
      `${CORE} version "${current}" is not a released stable version; ` +
        `package.json must hold the last released version.`,
    );
  }
  const [major, minor, patch] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, ".changeset", "config.json"), "utf8"),
  ) as { fixed?: string[][] };
  const bumps = pendingBumps(changesetDir);
  let bump: string | undefined;
  for (const name of fixedGroupOf(config, CORE)) {
    const pending = bumps.get(name);
    if (pending) bump = maxBump(pending, bump ?? "patch");
  }
  const version =
    bump === "major"
      ? `${major + 1}.0.0`
      : bump === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  return { version, proposed: bump !== undefined };
}

/** Core's version as the tree holds it, and the release it proposes. */
function coreRelease(): ReturnType<typeof nextCoreRelease> {
  return nextCoreRelease(
    readManifest(join(REPO_ROOT, "packages", "routecraft", "package.json"))
      .version,
    join(REPO_ROOT, ".changeset"),
  );
}

/** Declared ranges on core across the workspace, in reporting order. */
function declaredCoreRanges(): Array<{
  where: string;
  field: keyof typeof RANGE_FIELDS;
  range: string;
}> {
  const found: Array<{
    where: string;
    field: keyof typeof RANGE_FIELDS;
    range: string;
  }> = [];
  for (const path of workspaceManifestPaths()) {
    const manifest = readManifest(path);
    for (const field of Object.keys(RANGE_FIELDS) as Array<
      keyof typeof RANGE_FIELDS
    >) {
      const range = manifest[field]?.[CORE];
      if (range === undefined) continue;
      if (LOCAL_PROTOCOLS.some((protocol) => range.startsWith(protocol))) {
        continue;
      }
      found.push({ where: path.slice(REPO_ROOT.length + 1), field, range });
    }
  }
  return found;
}

describe("core version-range contract (ci-cd.md section 5)", () => {
  /**
   * @case Every declared range on @routecraft/routecraft admits the version that governs its field
   * @preconditions Ranges are read from every workspace manifest, skipping `workspace:`-style local protocols; a peer range is checked against the next release's version (core's manifest version plus the highest bump pending for its fixed group) and that version's `-canary-<datetime>` form, a regular range against the workspace's current version
   * @expectedResult Every range admits its target; one that refuses fails naming the manifest, the field, the declared range and the version it refuses
   */
  test("declared ranges admit the version that governs them", () => {
    const workspaceVersion = readManifest(
      join(REPO_ROOT, "packages", "routecraft", "package.json"),
    ).version;
    const release = coreRelease();
    if (release === null) return;
    const next = release.version;
    const targets = {
      local: [workspaceVersion!],
      published: release.proposed
        ? [next, `${next}-${SAMPLE_CANARY_SUFFIX}`]
        : [next],
    };
    const ranges = declaredCoreRanges();
    expect(ranges.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const { where, field, range } of ranges) {
      const resolution = RANGE_FIELDS[field];
      for (const version of targets[resolution]) {
        if (semver.satisfies(version, range)) continue;
        violations.push(
          resolution === "published"
            ? `${where}: ${field}["${CORE}"] declares "${range}", which does not admit ${version}, ` +
                `the version the next release publishes. Move the lower bound to ">=${next}-0" so the ` +
                `range admits both ${next} and its canary snapshots.`
            : `${where}: ${field}["${CORE}"] declares "${range}", which does not admit the workspace ` +
                `version ${version}, so bun install resolves a published copy of core here instead of ` +
                `the in-tree one. A regular dependency names the released line, and changesets moves it ` +
                `on every release.`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * @case A tree that proposes no release does not demand a range for a version nobody asked for
   * @preconditions An empty changeset directory, which is what a "Version Packages" branch and main straight after a release both look like
   * @expectedResult The next version is still computed as a patch, but it is reported as not proposed, so the canary form is not asserted and the release PR is not failed by a bound that cannot be chosen yet
   */
  test("an empty changeset directory proposes no release", () => {
    const dir = mkdtempSync(join(tmpdir(), "changesets-"));
    try {
      expect(nextCoreRelease("0.7.0", dir)).toEqual({
        version: "0.7.1",
        proposed: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case A pending bump on any member of core's fixed group proposes that release
   * @preconditions A changeset directory holding one minor bump on a fixed-group sibling rather than on core itself
   * @expectedResult Core's next version follows the group, and the release counts as proposed so the canary form is asserted
   */
  test("a fixed-group sibling's bump proposes core's next version", () => {
    const dir = mkdtempSync(join(tmpdir(), "changesets-"));
    try {
      writeFileSync(
        join(dir, "sibling.md"),
        '---\n"@routecraft/cli": minor\n---\n\nSomething.\n',
      );
      expect(nextCoreRelease("0.7.0", dir)).toEqual({
        version: "0.8.0",
        proposed: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case A snapshot working tree has nothing left to assert
   * @preconditions Core's version is a canary prerelease, which is what `changeset version --snapshot` leaves in the tree
   * @expectedResult No release is returned, so the contract skips rather than reporting a manifest defect for a version the release step just wrote
   */
  test("a snapshot tree yields no release to check", () => {
    const dir = mkdtempSync(join(tmpdir(), "changesets-"));
    try {
      expect(nextCoreRelease("0.7.0-canary-20260830132156", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case A version that is neither released nor a snapshot is a real defect
   * @preconditions Core's version is malformed
   * @expectedResult The computation throws naming the invariant, rather than silently skipping the contract
   */
  test("a malformed core version throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "changesets-"));
    try {
      expect(() => nextCoreRelease("not-a-version", dir)).toThrow(
        /last released version/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @case The peer check is sensitive to the prerelease form, not only the stable one
   * @preconditions A range whose lower bound carries no prerelease comparator, checked against a canary version on the same major.minor.patch
   * @expectedResult The bare range refuses the canary while the `-0` form admits it, which is the defect the contract above exists to catch
   */
  test("a lower bound without -0 refuses a canary on the same version", () => {
    const next = coreRelease()?.version ?? "0.7.0";
    const canary = `${next}-${SAMPLE_CANARY_SUFFIX}`;
    expect(semver.satisfies(canary, `>=${next} <1.0.0`)).toBe(false);
    expect(semver.satisfies(canary, `>=${next}-0 <1.0.0`)).toBe(true);
    expect(semver.satisfies(next, `>=${next}-0 <1.0.0`)).toBe(true);
  });
});
