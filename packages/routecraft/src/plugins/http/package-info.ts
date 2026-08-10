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
 * Resolution rule when a `package.json` IS present at a given level: the
 * walk commits to that level and never falls through to a parent, since
 * an ancestor's metadata is by definition less related to the running
 * service than the nearest manifest. Concretely:
 *
 * - Unreadable or malformed manifest: return `{}`. A corrupt local
 *   manifest must not silently get replaced with an unrelated parent's
 *   `name` / `version` on the publicly-served `/openapi.json`.
 * - Workspace-container manifest (a `workspaces` field, or a
 *   `pnpm-workspace.yaml` beside it): return `{}`. The container is
 *   repository infrastructure, not a service identity; it is typically
 *   private, often versionless, and changesets-style tooling never
 *   versions it, so its `version` silently goes stale. Advertising it
 *   on a public document mis-attributes the service, so the safe
 *   default is no identity at all (the OpenAPI builder's neutral
 *   fallbacks apply) until the caller sets `builtins.openapi.info`.
 *
 * `private: true` alone is NOT treated as a container marker: plenty of
 * real, deliberately-unpublished apps are private, and their own
 * `name` / `version` is exactly the identity their `/openapi.json`
 * should carry.
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
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<
          string,
          unknown
        >;
        if (isWorkspaceContainer(parsed, dir)) return {};
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

/**
 * A manifest counts as a workspace container when it declares workspaces
 * itself (npm / yarn / bun keep them in `package.json`) or when a
 * `pnpm-workspace.yaml` sits beside it (pnpm keeps them out of the
 * manifest entirely).
 */
function isWorkspaceContainer(
  manifest: Record<string, unknown>,
  dir: string,
): boolean {
  const workspaces = manifest["workspaces"];
  if (Array.isArray(workspaces)) return true;
  if (typeof workspaces === "object" && workspaces !== null) return true;
  try {
    return statSync(join(dir, "pnpm-workspace.yaml")).isFile();
  } catch {
    return false;
  }
}
