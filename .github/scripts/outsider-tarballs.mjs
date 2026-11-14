#!/usr/bin/env bun

/**
 * Runs the outsider suites against the packed tarballs.
 *
 * `packages/routecraft/test/outsider/` holds what a third party can build on
 * the published packages. In the workspace those suites resolve the packages
 * to their sources, which proves the contract compiles and behaves, and
 * nothing about what ships: an export the bundle drops, a missing `exports`
 * entry or a type the `.d.ts` loses passes there. This script packs core,
 * testing, ai and os, installs the tarballs into an empty project and runs
 * the same files, so the suites see only what a user would install.
 *
 * Run from the repo root after `bun run build`.
 *
 * Usage: bun .github/scripts/outsider-tarballs.mjs
 */

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workDir = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "routecraft-outsider-tarballs",
);
const packDir = join(workDir, "packs");
const projectDir = join(workDir, "project");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

const PACKAGES = ["routecraft", "testing", "ai", "os"];
const dependencies = {};
for (const name of PACKAGES) {
  const before = new Set(readdirSync(packDir));
  run(
    "bun",
    ["pm", "pack", "--destination", packDir],
    join(rootDir, "packages", name),
  );
  const packed = readdirSync(packDir).filter((file) => !before.has(file));
  if (packed.length !== 1) {
    console.error(
      `outsider-tarballs: expected one tarball for ${name}, got: ${packed.join(", ") || "none"}`,
    );
    process.exit(1);
  }
  dependencies[`@routecraft/${name}`] = `file:${join(packDir, packed[0])}`;
}

writeFileSync(
  join(projectDir, "package.json"),
  JSON.stringify(
    {
      name: "outsider",
      private: true,
      type: "module",
      dependencies,
      // A sibling's peer range would otherwise fetch core from the registry.
      overrides: {
        "@routecraft/routecraft": dependencies["@routecraft/routecraft"],
      },
    },
    null,
    2,
  ) + "\n",
);
run("bun", ["install"], projectDir);

cpSync(
  join(rootDir, "packages/routecraft/test/outsider"),
  join(projectDir, "outsider"),
  { recursive: true },
);
run("bun", ["test", "./outsider"], projectDir);

console.log("outsider-tarballs: the outsider suites pass on the tarballs.");
