import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import semver from "semver";

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
 * The pending-changeset scan below mirrors the one in
 * `scripts/prepare-canary-snapshot.mjs`; both have to read the same bump
 * intent out of `.changeset/*.md` for this check to describe what that script
 * will actually publish. Range satisfaction is asked of `semver` rather than
 * `Bun.semver` because node-semver is the engine changesets itself uses to
 * decide whether a declared range is out of range, and this check only means
 * something if it agrees with the code doing the rewriting.
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

type Bump = "patch" | "minor" | "major";
const BUMP_ORDER: Bump[] = ["patch", "minor", "major"];

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

/** Highest bump each package carries across the pending changesets. */
function pendingBumps(): Map<string, Bump> {
  const dir = join(REPO_ROOT, ".changeset");
  const bumps = new Map<string, Bump>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const frontMatter = readFileSync(join(dir, file), "utf8").match(
      /^---\r?\n([\s\S]*?)\r?\n---/,
    );
    if (!frontMatter?.[1]) continue;
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const release = line.match(
        /^\s*["']?([^"':\s]+)["']?\s*:\s*(patch|minor|major)\s*$/,
      );
      if (!release?.[1] || !release[2]) continue;
      const name = release[1];
      const bump = release[2] as Bump;
      const current = bumps.get(name);
      if (
        current === undefined ||
        BUMP_ORDER.indexOf(bump) > BUMP_ORDER.indexOf(current)
      ) {
        bumps.set(name, bump);
      }
    }
  }
  return bumps;
}

/** Names sharing core's `fixed` group, which always version in lockstep. */
function coreFixedGroup(): string[] {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, ".changeset", "config.json"), "utf8"),
  ) as { fixed?: string[][] };
  return (config.fixed ?? []).find((group) => group.includes(CORE)) ?? [CORE];
}

/**
 * The version a release cut from this tree would publish for core. The
 * manifest holds the last released version (`.standards/ci-cd.md` section 9),
 * so the next one is that version plus the highest bump any member of core's
 * fixed group carries. No pending changeset means a patch, which is what the
 * canary job's synthetic changeset falls back to.
 */
function nextCoreVersion(): string {
  const current = readManifest(
    join(REPO_ROOT, "packages", "routecraft", "package.json"),
  ).version;
  const parts = current?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) {
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
  const bumps = pendingBumps();
  let bump: Bump = "patch";
  for (const name of coreFixedGroup()) {
    const pending = bumps.get(name);
    if (pending && BUMP_ORDER.indexOf(pending) > BUMP_ORDER.indexOf(bump)) {
      bump = pending;
    }
  }
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
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
    const next = nextCoreVersion();
    const targets = {
      local: [workspaceVersion!],
      published: [next, `${next}-${SAMPLE_CANARY_SUFFIX}`],
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
   * @case The peer check is sensitive to the prerelease form, not only the stable one
   * @preconditions A range whose lower bound carries no prerelease comparator, checked against a canary version on the same major.minor.patch
   * @expectedResult The bare range refuses the canary while the `-0` form admits it, which is the defect the contract above exists to catch
   */
  test("a lower bound without -0 refuses a canary on the same version", () => {
    const next = nextCoreVersion();
    const canary = `${next}-${SAMPLE_CANARY_SUFFIX}`;
    expect(semver.satisfies(canary, `>=${next} <1.0.0`)).toBe(false);
    expect(semver.satisfies(canary, `>=${next}-0 <1.0.0`)).toBe(true);
    expect(semver.satisfies(next, `>=${next}-0 <1.0.0`)).toBe(true);
  });
});
