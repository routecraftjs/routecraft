#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Computes SHA-256 of capability files and updates the registry JSON.
 *
 * For each craft.yml provided, reads the sibling capability file, computes
 * its SHA-256 hash, and writes the entry into registry/<type>s.json
 * (e.g. registry/capabilities.json).
 *
 * Usage: node scripts/compute-sha.js <path-to-craft.yml> [...]
 *
 * @license Apache-2.0
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

/**
 * Resolve the capability file path from a craft.yml directory.
 * Looks for <id>.mjs, <id>.ts, <id>.js in the same directory.
 */
function resolveCapabilityFile(manifestDir, id) {
  for (const ext of [".mjs", ".ts", ".js"]) {
    const candidate = join(manifestDir, `${id}${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Compute SHA-256 hex digest of a file.
 */
function sha256(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get the registry JSON path for a given type.
 * capabilities -> registry/capabilities.json
 * examples -> registry/examples.json
 */
function registryPath(type) {
  const plural = type.endsWith("y") ? type.slice(0, -1) + "ies" : type + "s";
  return resolve("registry", `${plural}.json`);
}

// --- CLI entry point ---
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: node scripts/compute-sha.js <craft.yml> [...]");
  process.exit(1);
}

let hasErrors = false;

for (const file of files) {
  let manifest;
  try {
    manifest = parse(readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`✗  Failed to parse ${file}: ${err.message}`);
    hasErrors = true;
    continue;
  }

  const { id, version, type } = manifest;
  if (!id || !version || !type) {
    console.error(`✗  ${file}: missing id, version, or type`);
    hasErrors = true;
    continue;
  }

  // Examples do not get SHA verification
  if (type === "example") {
    console.log(`⊘  ${id}@${version}: examples are not SHA-verified, skipping`);
    continue;
  }

  const manifestDir = dirname(resolve(file));
  const capFile = resolveCapabilityFile(manifestDir, id);

  if (!capFile) {
    console.error(
      `✗  ${file}: capability file not found. Expected ${id}.mjs, ${id}.ts, or ${id}.js alongside craft.yml`,
    );
    hasErrors = true;
    continue;
  }

  const hash = sha256(capFile);
  console.log(`✓  ${id}@${version}: sha256 = ${hash}`);

  // Update registry JSON
  const regPath = registryPath(type);
  mkdirSync(dirname(regPath), { recursive: true });

  let registry = {};
  if (existsSync(regPath)) {
    try {
      registry = JSON.parse(readFileSync(regPath, "utf-8"));
    } catch {
      registry = {};
    }
  }

  if (!registry[id]) {
    registry[id] = { versions: {} };
  }

  // Preserve existing manifest metadata
  registry[id].versions[version] = {
    sha256: hash,
    ...(manifest.description && { description: manifest.description }),
    ...(manifest.dependencies && { dependencies: manifest.dependencies }),
    ...(manifest.requiredCapabilities && {
      requiredCapabilities: manifest.requiredCapabilities,
    }),
    ...(manifest.env && { env: manifest.env }),
    ...(manifest.tags && { tags: manifest.tags }),
    ...(manifest.author && { author: manifest.author }),
    ...(manifest.license && { license: manifest.license }),
    ...(manifest.name && { name: manifest.name }),
  };

  writeFileSync(regPath, JSON.stringify(registry, null, 2) + "\n");
  console.log(`✓  Updated ${regPath}`);

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    writeFileSync(outputFile, `id=${id}\nversion=${version}\nsha=${hash}\n`, {
      flag: "a",
    });
  }
}

if (hasErrors) {
  process.exit(1);
}
