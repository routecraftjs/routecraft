import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { CraftPlugin } from "@routecraft/routecraft";

/**
 * Module extensions the CLI will import, shared by `run` (its entry
 * file) and `start` (every discovered module) so one path is never
 * classified two ways.
 *
 * @internal
 */
export const MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/**
 * Filename stem that marks a directory as one capability. The
 * directory is the capability's home: colocated helpers, fixtures and
 * tests live beside it and are never imported by discovery.
 *
 * @internal
 */
const CAPABILITY_SENTINEL = "route";

/**
 * Directories discovery never walks into, at any depth. `__tests__`
 * and `__fixtures__` hold code that is not a capability;
 * `node_modules` and dot-folders are not authored project content.
 *
 * @internal
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "__tests__",
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
]);

/** True when `path` exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` exists and is a file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSkippedProjectDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

/**
 * True for a module file discovery may import: a supported extension,
 * not a declaration file, and not a test or spec.
 *
 * The test check matches the final `.test.<ext>` / `.spec.<ext>`
 * segment pair, so `route.test.ts` and `route.bun.test.ts` are both
 * excluded.
 */
function isImportableModule(name: string): boolean {
  if (!MODULE_EXTENSIONS.includes(extname(name))) return false;
  if (name.endsWith(".d.ts")) return false;
  return !/\.(test|spec)\.[^.]+$/.test(name);
}

/**
 * Return the capability sentinel file inside `dir`, if one is there.
 * A directory holding `route.ts` is one capability and everything else
 * inside it is private to that capability.
 */
function capabilityFile(dir: string): string | undefined {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = join(dir, `${CAPABILITY_SENTINEL}${ext}`);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Walk a convention folder and return every module to import, in path
 * order.
 *
 * `claim` lets a directory stand for one unit rather than being walked
 * into: the capability walk passes {@link capabilityFile}, so a folder
 * holding `route.ts` yields that file and its colocated tests, fixtures
 * and helpers are never seen. The root is never offered to `claim`,
 * which is what keeps `capabilities/` itself from being mistaken for a
 * capability.
 */
function collectModules(
  dir: string,
  claim?: (directory: string) => string | undefined,
): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedProjectDirectory(entry.name)) continue;
      const claimed = claim?.(child);
      if (claimed !== undefined) out.push(claimed);
      else out.push(...collectModules(child, claim));
      continue;
    }
    if (entry.isFile() && isImportableModule(entry.name)) out.push(child);
  }
  return out;
}

/**
 * Walk a `capabilities/` tree. Two forms, mixable in one tree: a
 * directory holding `route.ts` is one capability, and any other
 * importable module is a single-file capability. Every other directory
 * is a grouping folder.
 */
export function discoverCapabilityModules(dir: string): string[] {
  return collectModules(dir, capabilityFile).sort((a, b) => a.localeCompare(b));
}

/**
 * Walk a `plugins/` tree. Subfolders are grouping only; there is no
 * sentinel form, because a plugin is one module.
 */
export function discoverPluginModules(dir: string): string[] {
  return collectModules(dir).sort((a, b) => a.localeCompare(b));
}

/**
 * Name a module by its path relative to the project root, for log and
 * error messages that have to be actionable in a terminal.
 */
export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

/** Filename stem of the project configuration file. */
export const CONFIG_STEM = "craft.config";

/**
 * Locate the project configuration file directly under `root`.
 * Returns undefined when there is none.
 */
export function findConfigFile(root: string): string | undefined {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = join(root, `${CONFIG_STEM}${ext}`);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * True when `value` looks like a `CraftPlugin`: an object carrying a
 * callable `apply`. Structural rather than branded, matching how the
 * context itself consumes plugins.
 */
export function isPluginInstance(value: unknown): value is CraftPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { apply?: unknown }).apply === "function"
  );
}
