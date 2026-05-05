#!/usr/bin/env node

/**
 * Set version across all workspace packages
 * Usage: node .github/scripts/set-version.mjs <version>
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

const version = process.argv[2];

if (!version) {
  console.error("Usage: node set-version.mjs <version>");
  process.exit(1);
}

console.log(`Setting version to: ${version}`);

/**
 * Update a single package.json file
 */
function updatePackage(pkgPath) {
  if (!existsSync(pkgPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const oldVersion = pkg.version;

    // Update package version
    pkg.version = version;

    // Update workspace dependencies
    for (const depType of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      if (pkg[depType]) {
        for (const depName of Object.keys(pkg[depType])) {
          if (
            depName.startsWith("@routecraft/") ||
            depName === "create-routecraft"
          ) {
            const depValue = pkg[depType][depName];
            // Only update if it's a workspace protocol
            if (depValue.startsWith("workspace:")) {
              // Replace workspace protocol with real version for npm publish compatibility
              pkg[depType][depName] = `^${version}`;
            }
          }
        }
      }
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`✓ ${pkg.name}: ${oldVersion} → ${version}`);
    return true;
  } catch (error) {
    console.error(`✗ Failed to update ${pkgPath}:`, error.message);
    process.exit(1);
  }
}

/**
 * Update a Claude Code plugin manifest's version, if present.
 * Plugin manifests live at <package>/.claude-plugin/plugin.json.
 */
function updatePluginManifest(pkgDir) {
  const manifestPath = join(pkgDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return false;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.version !== "string") return false;
    const oldVersion = manifest.version;
    manifest.version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `✓ ${manifest.name ?? manifestPath}: ${oldVersion} → ${version} (plugin manifest)`,
    );
    return true;
  } catch (error) {
    console.error(`✗ Failed to update ${manifestPath}:`, error.message);
    process.exit(1);
  }
}

/**
 * Update the version of every plugin entry in a marketplace manifest.
 * Marketplace manifests live at <root>/.claude-plugin/marketplace.json.
 */
function updateMarketplaceManifest(rootPath) {
  const manifestPath = join(rootPath, ".claude-plugin", "marketplace.json");
  if (!existsSync(manifestPath)) {
    return 0;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.plugins)) return 0;
    let updated = 0;
    for (const entry of manifest.plugins) {
      if (entry && typeof entry.version === "string") {
        const oldVersion = entry.version;
        entry.version = version;
        console.log(
          `✓ marketplace plugin "${entry.name}": ${oldVersion} → ${version}`,
        );
        updated++;
      }
    }
    if (updated > 0) {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    return updated;
  } catch (error) {
    console.error(`✗ Failed to update ${manifestPath}:`, error.message);
    process.exit(1);
  }
}

/**
 * Find and update all packages in a directory
 */
function updatePackagesInDir(dirPath) {
  if (!existsSync(dirPath)) {
    return 0;
  }

  let count = 0;
  const dirs = readdirSync(dirPath).filter((name) => {
    const fullPath = join(dirPath, name);
    return statSync(fullPath).isDirectory();
  });

  for (const dir of dirs) {
    const pkgDir = join(dirPath, dir);
    const pkgPath = join(pkgDir, "package.json");
    if (updatePackage(pkgPath)) {
      count++;
    }
    if (updatePluginManifest(pkgDir)) {
      count++;
    }
  }

  return count;
}

let updatedCount = 0;

// Update root package.json
if (updatePackage(join(rootDir, "package.json"))) {
  updatedCount++;
}

// Update examples/package.json
if (updatePackage(join(rootDir, "examples", "package.json"))) {
  updatedCount++;
}

// Update all packages in packages/*
updatedCount += updatePackagesInDir(join(rootDir, "packages"));

// Update all packages in apps/*
updatedCount += updatePackagesInDir(join(rootDir, "apps"));

// Update root-level Claude Code plugin manifest, if present (when the repo root
// itself is a plugin, e.g. plugin.json next to a top-level skills/ directory)
if (updatePluginManifest(rootDir)) {
  updatedCount++;
}

// Update root-level marketplace manifest, if present
updatedCount += updateMarketplaceManifest(rootDir);

// Update CLI version in source code
const cliIndexPath = join(rootDir, "packages", "cli", "src", "index.ts");
if (existsSync(cliIndexPath)) {
  try {
    let cliContent = readFileSync(cliIndexPath, "utf8");
    const versionRegex = /\.version\(['"][0-9.a-zA-Z\-+]+['"]\)/;
    const newVersionLine = `.version("${version}")`;

    if (versionRegex.test(cliContent)) {
      cliContent = cliContent.replace(versionRegex, newVersionLine);
      writeFileSync(cliIndexPath, cliContent);
      console.log(`✓ Updated CLI version in source code → ${version}`);
      updatedCount++;
    } else {
      console.warn("⚠ Could not find version line in CLI index.ts");
    }
  } catch (error) {
    console.error(`✗ Failed to update CLI version:`, error.message);
    process.exit(1);
  }
}

console.log(`\nSuccessfully updated ${updatedCount} package(s)`);
