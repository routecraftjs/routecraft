#!/usr/bin/env node

/**
 * Sync version fields that live outside package.json manifests.
 *
 * Runs after `changeset version` (see the root `version-packages` script) so
 * derived version literals always match the workspace versions changesets
 * just wrote:
 *
 * - `.claude-plugin/plugin.json` `version` tracks the core package.
 * - `.claude-plugin/marketplace.json` every `plugins[].version` tracks the
 *   core package.
 *
 * The craft CLI needs no patching here: `packages/cli/src/index.ts` imports
 * the version from its own package.json and tsup inlines it at build time.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const coreVersion = JSON.parse(
  readFileSync(join(rootDir, "packages", "routecraft", "package.json"), "utf8"),
).version;

if (typeof coreVersion !== "string" || coreVersion.length === 0) {
  console.error("Could not read @routecraft/routecraft version");
  process.exit(1);
}

let updated = 0;

const pluginManifestPath = join(rootDir, ".claude-plugin", "plugin.json");
if (existsSync(pluginManifestPath)) {
  const manifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  if (
    typeof manifest.version === "string" &&
    manifest.version !== coreVersion
  ) {
    const old = manifest.version;
    manifest.version = coreVersion;
    writeFileSync(pluginManifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`plugin.json: ${old} -> ${coreVersion}`);
    updated++;
  }
}

const marketplacePath = join(rootDir, ".claude-plugin", "marketplace.json");
if (existsSync(marketplacePath)) {
  const manifest = JSON.parse(readFileSync(marketplacePath, "utf8"));
  if (Array.isArray(manifest.plugins)) {
    let touched = false;
    for (const entry of manifest.plugins) {
      if (
        entry &&
        typeof entry.version === "string" &&
        entry.version !== coreVersion
      ) {
        console.log(
          `marketplace.json "${entry.name}": ${entry.version} -> ${coreVersion}`,
        );
        entry.version = coreVersion;
        touched = true;
        updated++;
      }
    }
    if (touched) {
      writeFileSync(marketplacePath, JSON.stringify(manifest, null, 2) + "\n");
    }
  }
}

console.log(
  updated === 0
    ? `Derived versions already match ${coreVersion}`
    : `Synced ${updated} derived version field(s) to ${coreVersion}`,
);
