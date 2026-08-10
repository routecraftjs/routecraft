import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Module extensions the project runtime will import. Mirrors what
 * `craft run` accepts for its entry file.
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
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSkippedDirectory(name: string): boolean {
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
export function isImportableModule(name: string): boolean {
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
 * Walk a `capabilities/` tree and return every module that should be
 * imported, in path order.
 *
 * Two forms are recognised, and they can be mixed in one tree:
 *
 * - **Folder form.** A directory holding `route.ts` is one capability.
 *   The file is imported and the directory is not descended into, so
 *   colocated tests, fixtures and private helpers are never loaded.
 * - **Single-file form.** Any other importable module is one
 *   capability on its own.
 *
 * A directory that is neither is a grouping folder (a domain) and is
 * walked.
 */
export function discoverCapabilityModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    const sentinel = capabilityFile(current);
    if (sentinel !== undefined) {
      out.push(sentinel);
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) continue;
        walk(child);
        continue;
      }
      if (entry.isFile() && isImportableModule(entry.name)) out.push(child);
    }
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedDirectory(entry.name)) continue;
      walk(child);
      continue;
    }
    if (entry.isFile() && isImportableModule(entry.name)) out.push(child);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Walk a `plugins/` tree and return every module that should be
 * imported, in path order. Subfolders are grouping only; there is no
 * sentinel form, because a plugin is one module.
 */
export function discoverPluginModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) continue;
        walk(child);
        continue;
      }
      if (entry.isFile() && isImportableModule(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
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
export function isPluginInstance(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { apply?: unknown }).apply === "function"
  );
}
