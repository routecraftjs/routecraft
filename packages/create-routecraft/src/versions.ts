import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The caret range of every published `@routecraft/*` package under a
 * workspace `packages/` directory, keyed by package name.
 *
 * Each package keeps its own number: the core train shares one, while
 * `@routecraft/ai`, `@routecraft/os` and every future vendor package version
 * independently (`.standards/ci-cd.md`). Shared by the build, which bakes the
 * map into the published scaffolder, and by a run from source.
 */
export function workspaceVersions(packagesDir: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      name?: unknown;
      version?: unknown;
      private?: unknown;
    };
    if (
      typeof manifest.name === "string" &&
      manifest.name.startsWith("@routecraft/") &&
      manifest.private !== true &&
      typeof manifest.version === "string"
    ) {
      versions[manifest.name] = `^${manifest.version}`;
    }
  }
  return versions;
}
