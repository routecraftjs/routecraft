#!/usr/bin/env bun

/**
 * Builds the project a user deploys, so CI can scan what actually ships rather
 * than what the monorepo's lockfile holds.
 *
 * Profiles:
 * - `starter`: the `create-routecraft` scaffold, core and CLI only. Its
 *   Dockerfile is the one the scaffolder writes.
 * - `adapters`: the starter plus `@routecraft/ai`, `@routecraft/os` and every
 *   optional peer the three packages declare, at the newest version their
 *   declared ranges allow. This is the dependency tree a project using the
 *   adapters resolves today, and the only one where a CVE in an adapter's
 *   library is visible. Scanned as a lockfile, not an image.
 *
 * Sources:
 * - default: this checkout's packages, packed. The packages must be built
 *   first (`bun run build`). The starter's Dockerfile gains one line so its
 *   install stage sees the packed tarballs; nothing else departs from what
 *   ships.
 * - `--from-npm`: the latest published packages, for the scheduled rescan of
 *   what users already run. The Dockerfile is used exactly as scaffolded.
 *
 * Usage: bun .github/scripts/security-reference-project.ts <starter|adapters> <out-dir> [--from-npm]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { generateProjectStructure } from "../../packages/create-routecraft/src/lib.ts";

type Profile = "starter" | "adapters";

const args = process.argv.slice(2);
const fromNpm = args.includes("--from-npm");
const [profileArg, outArg] = args.filter((arg) => arg !== "--from-npm");
if ((profileArg !== "starter" && profileArg !== "adapters") || !outArg) {
  console.error(
    "Usage: bun .github/scripts/security-reference-project.ts <starter|adapters> <out-dir> [--from-npm]",
  );
  process.exit(2);
}
const profile: Profile = profileArg;
const outDir = resolve(outArg);
const repoRoot = resolve(import.meta.dir, "..", "..");

const packages =
  profile === "starter"
    ? ["routecraft", "cli"]
    : ["routecraft", "cli", "ai", "os"];

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(path, "utf8")) as Manifest;

const repoManifest = (dir: string): Manifest =>
  readManifest(join(repoRoot, "packages", dir, "package.json"));

const run = (cmd: string, args: string[], cwd: string): void => {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

/** Every optional peer a package declares, with the range it declares. */
const optionalPeers = (manifest: Manifest): Record<string, string> => {
  const peers: Record<string, string> = {};
  for (const [name, meta] of Object.entries(
    manifest.peerDependenciesMeta ?? {},
  )) {
    const range = manifest.peerDependencies?.[name];
    if (!meta.optional || !range) continue;
    if (name.startsWith("@routecraft/")) continue;
    peers[name] = range;
  }
  return peers;
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(fromNpm ? outDir : join(outDir, "vendor"), { recursive: true });

await generateProjectStructure(outDir, {
  projectName: `routecraft-${profile}`,
  example: "",
  packageManager: "bun",
  skipInstall: true,
  git: false,
  force: true,
  yes: true,
});

const projectManifestPath = join(outDir, "package.json");
const project = readManifest(projectManifestPath);
project.dependencies = { ...project.dependencies };
// The image installs with --production, so devDependencies are never shipped.
// They also pin the scaffold's own @routecraft version, which is unpublished
// on the version-bump commit and would fail the install that releases hang on.
delete project.devDependencies;

if (fromNpm) {
  for (const dir of packages) {
    project.dependencies[repoManifest(dir).name] = "latest";
  }
} else {
  const tarballs = new Map<string, string>();
  for (const dir of packages) {
    const manifest = repoManifest(dir);
    run(
      "bun",
      ["pm", "pack", "--quiet", "--destination", join(outDir, "vendor")],
      join(repoRoot, "packages", dir),
    );
    const file = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
    tarballs.set(manifest.name, `file:./vendor/${file}`);
  }
  for (const [name, spec] of tarballs) project.dependencies[name] = spec;
  // The CLI and the adapter packages depend on core by semver range; the
  // override makes them resolve this checkout's core, not the registry's.
  project.overrides = {
    "@routecraft/routecraft": tarballs.get("@routecraft/routecraft")!,
  };
}

if (profile === "adapters") {
  // The published packages' declared ranges when scanning what users run,
  // this checkout's when scanning a change.
  for (const dir of ["routecraft", "ai", "os"]) {
    const manifest = fromNpm
      ? (JSON.parse(
          execFileSync(
            "npm",
            ["view", `${repoManifest(dir).name}@latest`, "--json"],
            { encoding: "utf8" },
          ),
        ) as Manifest)
      : repoManifest(dir);
    Object.assign(project.dependencies, optionalPeers(manifest));
  }
}

writeFileSync(projectManifestPath, `${JSON.stringify(project, null, 2)}\n`);

// Lifecycle scripts are skipped: the scan reads what is installed, not what a
// postinstall would download or compile.
run("bun", ["install", "--ignore-scripts"], outDir);

if (profile === "starter" && !fromNpm) {
  // The one departure from the shipped Dockerfile: the install stage has to
  // see the packed tarballs `package.json` points at.
  const dockerfilePath = join(outDir, "Dockerfile");
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const anchor = "COPY package.json bun.lock ./\n";
  if (!dockerfile.includes(anchor)) {
    throw new Error(
      `The scaffolded Dockerfile no longer contains "${anchor.trim()}"; update this script.`,
    );
  }
  writeFileSync(
    dockerfilePath,
    dockerfile.replace(anchor, `${anchor}COPY vendor ./vendor\n`),
  );
}

console.log(
  `Reference project (${profile}, ${fromNpm ? "published packages" : "this checkout"}) ready at ${outDir}`,
);
