#!/usr/bin/env node

/**
 * Smoke-test publishable artifacts: pack routecraft + CLI, install with npm
 * in a clean temp dir, run npx craft --version and npx craft run <example>.
 * Run from repo root after set-version and build. Uses only npm (no pnpm)
 * so behavior matches real npx @routecraft/cli users.
 *
 * Usage: node .github/scripts/smoke-test-publishable.mjs [version]
 *   version: optional; defaults to packages/routecraft/package.json version
 */

import { mkdirSync, cpSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

const version =
  process.argv[2] ||
  JSON.parse(
    readFileSync(join(rootDir, "packages/routecraft/package.json"), "utf8"),
  ).version;

if (!version) {
  console.error("Usage: node smoke-test-publishable.mjs [version]");
  process.exit(1);
}

const packDir = join(rootDir, "dist", "packs");
const smokeDir = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, "smoke-publish")
  : join(tmpdir(), "routecraft-smoke-publish");

function run(cmd, opts = {}) {
  const cwd = opts.cwd || rootDir;
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd,
    stdio: "inherit",
    ...opts,
  });
}

console.log(`Smoke testing publishable packages (version: ${version})\n`);

// 1. Create pack dir and pack routecraft + CLI
mkdirSync(packDir, { recursive: true });

run(`npm pack --pack-destination "${packDir}"`, {
  cwd: join(rootDir, "packages/routecraft"),
});
run(`npm pack --pack-destination "${packDir}"`, {
  cwd: join(rootDir, "packages/cli"),
});

const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 2) {
  console.error(
    `Expected 2 tarballs in ${packDir}, got: ${tarballs.join(", ") || "none"}`,
  );
  process.exit(1);
}

// 2. Temp dir: npm init + install from tarballs only
mkdirSync(smokeDir, { recursive: true });
run("npm init -y", { cwd: smokeDir });

const installPaths = tarballs.map((t) => join(packDir, t)).join(" ");
run(`npm install ${installPaths}`, { cwd: smokeDir });

// 3. npx craft --version
run("npx craft --version", { cwd: smokeDir });

// 4. Copy example route and run
const examplePath = join(rootDir, "examples", "hello-world.mjs");
if (!existsSync(examplePath)) {
  console.error(`Example not found: ${examplePath}`);
  process.exit(1);
}
cpSync(examplePath, join(smokeDir, "hello-world.mjs"));
run("npx craft run --log-level debug hello-world.mjs", { cwd: smokeDir });

console.log("\nSmoke test passed.");
