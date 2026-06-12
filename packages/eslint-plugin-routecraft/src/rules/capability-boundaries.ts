import type { Rule } from "eslint";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Spring-Modulith-style capability boundary rule.
 *
 * A "capability" is a folder that contains the public-surface file (`route.ts`
 * by default) somewhere under a `capabilities/` directory. The capability's
 * route file is its only public surface; every other file in the folder is
 * internal. From outside a capability, only its public surface may be imported.
 *
 * The rule resolves relative specifiers itself (it never needs
 * `eslint-import-resolver-typescript`) and compares basenames without
 * extensions, so an ESM `./mapper.js` specifier resolves to its `./mapper.ts`
 * source. Bare specifiers (`@scope/*`, framework packages, node builtins) are
 * always allowed, so cross-package sharing keeps working.
 */

// Extensions we treat as interchangeable when comparing a specifier against the
// public-surface file name. An ESM build emits `.js` specifiers that map to
// `.ts` sources, so `route.js` and `route.ts` are the same public surface.
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function stripModuleExtension(name: string): string {
  for (const ext of MODULE_EXTENSIONS) {
    if (name.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
  }
  return name;
}

interface CapabilityBoundariesOptions {
  capabilitiesDir: string;
  publicSurface: string;
}

const DEFAULT_OPTIONS: CapabilityBoundariesOptions = {
  capabilitiesDir: "capabilities",
  publicSurface: "route.ts",
};

/**
 * Does `dir` directly contain the public-surface file?
 *
 * Detection is extension-agnostic so it stays consistent with the public-surface
 * comparison in the rule body: pointing the rule at a source tree (`route.ts`)
 * or an emitted tree (`route.js`) both work, and configuring
 * `publicSurface: "route.js"` does not silently disable the rule.
 */
function hasPublicSurface(
  dir: string,
  options: CapabilityBoundariesOptions,
): boolean {
  if (existsSync(join(dir, options.publicSurface))) {
    return true;
  }
  const stem = stripModuleExtension(options.publicSurface);
  // Only probe extension variants when publicSurface actually carries a module
  // extension; a bare name like "PUBLIC" should match literally, nothing else.
  if (stem !== options.publicSurface) {
    for (const ext of MODULE_EXTENSIONS) {
      if (existsSync(join(dir, stem + ext))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find the capability directory that owns `startDir`, or null when `startDir`
 * is not inside a capability.
 *
 * A capability directory is the nearest ancestor of `startDir` (inclusive) that
 * (a) lives under a `capabilitiesDir` segment and (b) directly contains the
 * public-surface file. Domain grouping folders (which hold no `route.ts`) and
 * the `capabilitiesDir` itself are never capabilities.
 */
function findCapabilityDir(
  startDir: string,
  options: CapabilityBoundariesOptions,
): string | null {
  // Cheap guard: a capability can only exist under the capabilities root.
  if (!startDir.split(sep).includes(options.capabilitiesDir)) {
    return null;
  }

  let dir = startDir;
  while (true) {
    // Reaching the capabilities root means we never found an owning capability.
    if (basename(dir) === options.capabilitiesDir) {
      return null;
    }
    if (hasPublicSurface(dir, options)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Filesystem root; stop walking.
      return null;
    }
    dir = parent;
  }
}

/**
 * The `source` of an import/export-from declaration is a string Literal node.
 * We type it structurally to avoid an `@types/estree` dependency (matching the
 * other rules in this plugin, which type-guard ESTree shapes locally).
 */
interface SourceLiteral {
  value: unknown;
}

function getSourceLiteral(node: unknown): SourceLiteral | null {
  if (typeof node !== "object" || node === null || !("source" in node)) {
    return null;
  }
  const source = (node as { source?: unknown }).source;
  if (
    typeof source === "object" &&
    source !== null &&
    "value" in source &&
    "type" in source
  ) {
    return source as SourceLiteral;
  }
  return null;
}

interface ResolvedTarget {
  /** Directory the specifier resolves into. */
  dir: string;
  /** File basename, or null when the specifier resolves to a directory. */
  base: string | null;
}

/**
 * Resolve a relative specifier to the directory it lands in plus the imported
 * file basename. Directory specifiers (which resolve to an `index` barrel, not
 * the public surface) report a null basename so they are never mistaken for the
 * public surface.
 */
function resolveTarget(fromDir: string, specifier: string): ResolvedTarget {
  const resolved = resolve(fromDir, specifier);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return { dir: resolved, base: null };
  }
  return { dir: dirname(resolved), base: basename(resolved) };
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce capability module boundaries: from outside a capability folder, import only its public-surface route file, never its internals.",
      // Opt-in only. This encodes a specific repository layout
      // (`capabilities/<domain>/<capability>/route.ts`) and must not be turned
      // on by the plugin's recommended or all configs.
      recommended: false,
    },
    messages: {
      crossCapabilityInternalImport:
        "capability-boundaries: '{{specifier}}' reaches into capability '{{capability}}' internals. From outside a capability, import only its public surface ('{{surface}}'); share via a direct() route or a shared package instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          capabilitiesDir: {
            type: "string",
            description:
              "Directory name that marks the capabilities root. Defaults to 'capabilities'.",
          },
          publicSurface: {
            type: "string",
            description:
              "File name that is a capability's public surface. Defaults to 'route.ts'.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const rawOptions = (context.options[0] ??
      {}) as Partial<CapabilityBoundariesOptions>;
    const options: CapabilityBoundariesOptions = {
      capabilitiesDir:
        rawOptions.capabilitiesDir ?? DEFAULT_OPTIONS.capabilitiesDir,
      publicSurface: rawOptions.publicSurface ?? DEFAULT_OPTIONS.publicSurface,
    };

    const filename = context.physicalFilename ?? context.filename;
    // RuleTester and some processors hand back virtual names like "<input>";
    // path logic needs a real absolute path to resolve against.
    if (!filename || !isAbsolute(filename)) {
      return {};
    }

    const currentDir = dirname(filename);
    const sourceCapDir = findCapabilityDir(currentDir, options);
    const publicSurfaceStem = stripModuleExtension(options.publicSurface);

    function checkSource(node: unknown): void {
      const source = getSourceLiteral(node);
      if (!source) return;
      const specifier = source.value;
      if (typeof specifier !== "string") return;
      // Only relative specifiers can cross a capability boundary in-tree.
      // Bare specifiers (packages, framework, node builtins) are always allowed.
      if (!specifier.startsWith(".")) return;

      const target = resolveTarget(currentDir, specifier);
      const targetCapDir = findCapabilityDir(target.dir, options);

      // Target is not inside any capability: shared/non-capability code, allowed.
      if (!targetCapDir) return;

      // Intra-capability import: unrestricted.
      if (targetCapDir === sourceCapDir) return;

      // The capability's public surface is the one cross-boundary file allowed.
      const isPublicSurface =
        target.base !== null &&
        stripModuleExtension(target.base) === publicSurfaceStem &&
        target.dir === targetCapDir;
      if (isPublicSurface) return;

      context.report({
        node: source as unknown as Rule.Node,
        messageId: "crossCapabilityInternalImport",
        data: {
          specifier,
          capability: basename(targetCapDir),
          surface: options.publicSurface,
        },
      });
    }

    return {
      ImportDeclaration(node) {
        checkSource(node);
      },
      ExportNamedDeclaration(node) {
        checkSource(node);
      },
      ExportAllDeclaration(node) {
        checkSource(node);
      },
    };
  },
};

export default rule;
