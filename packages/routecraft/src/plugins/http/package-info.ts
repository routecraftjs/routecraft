import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Subset of `package.json` fields the http plugin auto-detects for the
 * OpenAPI `info` block. Conservative on purpose: only `name` and `version`
 * are public-by-nature on npm. Description / author / license are NOT
 * pulled here even when present, so they cannot accidentally leak
 * through the publicly-served `/openapi.json` doc.
 */
export interface PackageInfo {
  name?: string;
  version?: string;
}

/**
 * Walk upward from `start` looking for the nearest `package.json` and
 * return its `name` / `version`. Returns `{}` (no fields) if no
 * `package.json` is found or the file is malformed. Never throws -- the
 * plugin must still apply when running in environments without a
 * `package.json` on disk (single-file bundled binaries, Docker scratch
 * images), falling back to hard-coded defaults in the OpenAPI builder.
 */
export function findPackageInfo(start: string = process.cwd()): PackageInfo {
  let dir = start;
  // Bounded climb to avoid surprises on misconfigured environments. 32 is
  // far beyond any realistic project depth.
  for (let i = 0; i < 32; i++) {
    const candidate = join(dir, "package.json");
    try {
      if (statSync(candidate).isFile()) {
        const text = readFileSync(candidate, "utf8");
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const info: PackageInfo = {};
        if (typeof parsed["name"] === "string") info.name = parsed["name"];
        if (typeof parsed["version"] === "string") {
          info.version = parsed["version"];
        }
        return info;
      }
    } catch {
      // statSync throws when the candidate doesn't exist; readFileSync /
      // JSON.parse throw on permission errors or malformed content.
      // Either way, fall through to the parent directory.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}
