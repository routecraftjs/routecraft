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
              pkg[depType][depName] = `workspace:^${version}`;
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
    const pkgPath = join(dirPath, dir, "package.json");
    if (updatePackage(pkgPath)) {
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

// Update CLI version in source code
const cliIndexPath = join(rootDir, "packages", "cli", "src", "index.ts");
if (existsSync(cliIndexPath)) {
  try {
    let cliContent = readFileSync(cliIndexPath, "utf8");
    const versionRegex = /\.version\(['"][\d.]+['"]\)/;
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
