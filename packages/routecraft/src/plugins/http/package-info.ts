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
 * `package.json` is reachable. Never throws -- the plugin must still
 * apply when running in environments without a `package.json` on disk
 * (single-file bundled binaries, Docker scratch images), falling back
 * to hard-coded defaults in the OpenAPI builder.
 *
 * Resolution rule when a `package.json` IS present at a given level but
 * unreadable or malformed: the walk stops at that level and returns `{}`
 * rather than falling through to the parent. A corrupt local manifest
 * must not silently get replaced with an unrelated parent's metadata
 * (notably the monorepo root's), since that mis-attributed `name` /
 * `version` would then leak through the publicly-served `/openapi.json`.
 */
export function findPackageInfo(start: string = process.cwd()): PackageInfo {
  let dir = start;
  // Bounded climb to avoid surprises on misconfigured environments. 32 is
  // far beyond any realistic project depth.
  for (let i = 0; i < 32; i++) {
    const candidate = join(dir, "package.json");
    let exists = false;
    try {
      exists = statSync(candidate).isFile();
    } catch {
      // statSync throws when the candidate doesn't exist (ENOENT) or on
      // permission errors. Treat both as "not here, try the parent" -- the
      // only path where falling through to a parent directory is correct.
      exists = false;
    }
    if (exists) {
      // The file is present at this level. Commit to it: if read or parse
      // fails, return empty rather than silently inheriting the parent's
      // metadata. A corrupt local package.json must not get replaced with
      // (e.g.) the monorepo root's name/version on the publicly-served
      // /openapi.json doc.
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<
          string,
          unknown
        >;
        const info: PackageInfo = {};
        if (typeof parsed["name"] === "string") info.name = parsed["name"];
        if (typeof parsed["version"] === "string") {
          info.version = parsed["version"];
        }
        return info;
      } catch {
        return {};
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}
