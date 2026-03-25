#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Validates craft.yml manifest files in the registry.
 *
 * Checks:
 * - Required fields: type, id, version, description
 * - Valid type values: capability, agent, skill, example
 * - Valid semver version
 * - id is lowercase hyphen-separated
 * - No sha256 field authored (CI computes it)
 *
 * Usage: node scripts/validate-manifest.js <path-to-craft.yml> [...]
 *
 * @license Apache-2.0
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

const VALID_TYPES = ["capability", "agent", "skill", "example"];
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validate a single craft.yml manifest.
 * @param {string} filePath - Path to the craft.yml file.
 * @returns {{ id: string, version: string, type: string, errors: string[] }}
 */
function validateManifest(filePath) {
  const errors = [];
  let manifest;

  try {
    const raw = readFileSync(filePath, "utf-8");
    manifest = parse(raw);
  } catch (err) {
    return {
      id: "",
      version: "",
      type: "",
      errors: [`Failed to parse ${filePath}: ${err.message}`],
    };
  }

  if (!manifest || typeof manifest !== "object") {
    return {
      id: "",
      version: "",
      type: "",
      errors: [`${filePath}: manifest is empty or not an object`],
    };
  }

  // Required fields
  for (const field of ["type", "id", "version", "description"]) {
    if (!manifest[field]) {
      errors.push(`${filePath}: missing required field "${field}"`);
    }
  }

  // Type validation
  if (manifest.type && !VALID_TYPES.includes(manifest.type)) {
    errors.push(
      `${filePath}: invalid type "${manifest.type}". Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  // ID validation
  if (manifest.id && !ID_RE.test(manifest.id)) {
    errors.push(
      `${filePath}: invalid id "${manifest.id}". Must be lowercase, hyphen-separated (e.g. "elastic-logs")`,
    );
  }

  // Version validation
  if (manifest.version && !SEMVER_RE.test(String(manifest.version))) {
    errors.push(
      `${filePath}: invalid version "${manifest.version}". Must be a valid semver (e.g. "1.0.0")`,
    );
  }

  // sha256 should not be authored
  if (manifest.sha256) {
    errors.push(
      `${filePath}: sha256 must not be authored manually. CI computes it on merge.`,
    );
  }

  // dependencies should be an object if present
  if (manifest.dependencies && typeof manifest.dependencies !== "object") {
    errors.push(
      `${filePath}: dependencies must be a map of package name to version range`,
    );
  }

  // env should be an array if present
  if (manifest.env && !Array.isArray(manifest.env)) {
    errors.push(
      `${filePath}: env must be an array of environment variable names`,
    );
  }

  // requiredCapabilities should be an array if present
  if (
    manifest.requiredCapabilities &&
    !Array.isArray(manifest.requiredCapabilities)
  ) {
    errors.push(`${filePath}: requiredCapabilities must be an array`);
  }

  // tags should be an array if present
  if (manifest.tags && !Array.isArray(manifest.tags)) {
    errors.push(`${filePath}: tags must be an array`);
  }

  return {
    id: manifest.id || "",
    version: String(manifest.version || ""),
    type: manifest.type || "",
    errors,
  };
}

// --- CLI entry point ---
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: node scripts/validate-manifest.js <craft.yml> [...]");
  process.exit(1);
}

let hasErrors = false;

for (const file of files) {
  const result = validateManifest(file);

  if (result.errors.length > 0) {
    hasErrors = true;
    for (const err of result.errors) {
      console.error(`✗  ${err}`);
    }
  } else {
    console.log(`✓  ${file}: ${result.id}@${result.version} (${result.type})`);
  }
}

if (hasErrors) {
  process.exit(1);
}
