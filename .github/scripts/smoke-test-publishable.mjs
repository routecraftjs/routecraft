#!/usr/bin/env node

/**
 * Smoke-test publishable artifacts: pack routecraft, CLI, and testing; install
 * with npm in a clean temp dir, run npx craft --version and npx craft run <example>.
 * Run from repo root after set-version and build. Uses only npm (no pnpm)
 * so behavior matches real npx @routecraft/cli users.
 *
 * Usage: node .github/scripts/smoke-test-publishable.mjs [version]
 *   version: optional; defaults to packages/routecraft/package.json version
 */

import {
  mkdirSync,
  cpSync,
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
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

// 1. Create pack dir and pack routecraft, cli, and testing
const publishablePackages = ["routecraft", "cli", "testing"];
mkdirSync(packDir, { recursive: true });

for (const pkg of publishablePackages) {
  run(`npm pack --pack-destination "${packDir}"`, {
    cwd: join(rootDir, "packages", pkg),
  });
}

const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
const expectedCount = publishablePackages.length;
if (tarballs.length !== expectedCount) {
  console.error(
    `Expected ${expectedCount} tarballs in ${packDir}, got: ${tarballs.join(", ") || "none"}`,
  );
  process.exit(1);
}

// 2. Temp dir: npm init + install from tarballs only
mkdirSync(smokeDir, { recursive: true });
run("npm init -y", { cwd: smokeDir });
const smokePkgPath = join(smokeDir, "package.json");
const smokePkg = JSON.parse(readFileSync(smokePkgPath, "utf8"));
smokePkg.type = "module";
writeFileSync(smokePkgPath, JSON.stringify(smokePkg, null, 2) + "\n");

const installPaths = tarballs.map((t) => join(packDir, t)).join(" ");
run(`npm install ${installPaths}`, { cwd: smokeDir });

// 3. npx craft --version
run("npx craft --version", { cwd: smokeDir });

// 4. Copy built example route (TS → dist/hello-world.js) and run
const examplePath = join(rootDir, "examples", "dist", "hello-world.js");
if (!existsSync(examplePath)) {
  console.error(`Example not found: ${examplePath} (run pnpm run build first)`);
  process.exit(1);
}
const smokeDist = join(smokeDir, "dist");
mkdirSync(smokeDist, { recursive: true });
cpSync(examplePath, join(smokeDist, "hello-world.js"));
run("npx craft run --log-level debug dist/hello-world.js", { cwd: smokeDir });

console.log("\nSmoke test passed.");
