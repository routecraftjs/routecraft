/**
 * craft add: download a capability from the registry, verify its SHA,
 * install dependencies, and optionally update index.ts.
 */

import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/routecraftjs/routecraft-registry/refs/heads/main/";

/**
 * Domains considered official / trusted by default.
 * Any registry URL not matching one of these requires --allow-unofficial.
 */
const OFFICIAL_DOMAINS = [
  "raw.githubusercontent.com/routecraftjs/",
  "github.com/routecraftjs/",
  "registry.routecraft.dev",
] as const;

/** Safe pattern for npm package names (scoped or unscoped). */
const SAFE_PKG_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function isOfficialRegistry(url: string): boolean {
  return OFFICIAL_DOMAINS.some((domain) => url.includes(domain));
}

interface RegistryEntry {
  versions: Record<
    string,
    {
      sha256: string;
      description?: string;
      dependencies?: Record<string, string>;
      requiredCapabilities?: string[];
      env?: string[];
      name?: string;
    }
  >;
}

type RegistryJson = Record<string, RegistryEntry>;

interface AddOptions {
  registry: string;
  dir: string;
  noIndex: boolean;
  noVerify: boolean;
  allowUnofficial: boolean;
}

/**
 * Resolve the latest version from a registry entry.
 */
function latestVersion(entry: RegistryEntry): string {
  const versions = Object.keys(entry.versions);
  if (versions.length === 0) {
    throw new Error("No versions available");
  }
  return versions
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    )
    .pop()!;
}

/**
 * Convert a capability id to a camelCase import name.
 * e.g. "elastic-logs" -> "elasticLogsCapability"
 */
function toImportName(id: string): string {
  const camel = id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return `${camel}Capability`;
}

/**
 * Fetch JSON from a URL.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch raw bytes from a URL.
 */
async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Compute SHA-256 hex digest of a Buffer.
 */
function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Parse an id[@version] specifier.
 */
function parseSpecifier(spec: string): { id: string; version?: string } {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex > 0) {
    return { id: spec.slice(0, atIndex), version: spec.slice(atIndex + 1) };
  }
  return { id: spec };
}

/**
 * Detect circular dependencies during recursive install.
 */
function checkCircularDeps(id: string, version: string, chain: string[]): void {
  const key = `${id}@${version}`;
  if (chain.includes(key)) {
    throw new Error(
      `Circular dependency detected: ${[...chain, key].join(" -> ")}`,
    );
  }
}

/**
 * Install a single capability from the registry.
 * Returns env vars that need to be set.
 *
 * Tracks installed capabilities by id (not id@version). If the same id
 * is requested again (e.g. by two different parent capabilities), the
 * second request is skipped since only one version can exist in the
 * flat capabilities/ directory.
 *
 * Required capabilities always resolve to latest regardless of what
 * version the parent pinned. The pinned version is treated as a minimum
 * compatibility hint, not an install target.
 */
async function installCapability(
  id: string,
  version: string | undefined,
  registry: RegistryJson,
  options: AddOptions,
  installed: Map<string, string>,
  chain: string[],
  parentId?: string,
): Promise<{ envVars: string[]; installedDeps: Record<string, string> }> {
  const entry = registry[id];
  if (!entry) {
    throw new Error(
      `Capability "${id}" not found in the registry. Check the id and try again.`,
    );
  }

  // Always resolve to latest for required capabilities (parentId set).
  // Only honour an explicit version for top-level user requests.
  const resolvedVersion =
    parentId !== undefined
      ? latestVersion(entry)
      : (version ?? latestVersion(entry));
  const versionData = entry.versions[resolvedVersion];
  if (!versionData) {
    const available = Object.keys(entry.versions).join(", ");
    throw new Error(
      `Version "${resolvedVersion}" of "${id}" not found. Available: ${available}`,
    );
  }

  // Skip if this id is already installed (by id, not id@version)
  if (installed.has(id)) {
    return { envVars: [], installedDeps: {} };
  }

  // Circular dependency check
  const key = `${id}@${resolvedVersion}`;
  checkCircularDeps(id, resolvedVersion, chain);

  // Install required capabilities first (recursive)
  const allEnvVars: string[] = [];
  const allDeps: Record<string, string> = {};

  if (versionData.requiredCapabilities) {
    for (const reqSpec of versionData.requiredCapabilities) {
      const { id: reqId } = parseSpecifier(reqSpec);
      const result = await installCapability(
        reqId,
        undefined,
        registry,
        options,
        installed,
        [...chain, key],
        id,
      );
      allEnvVars.push(...result.envVars);
      Object.assign(allDeps, result.installedDeps);
    }
  }

  // Fetch the capability file
  const registryBase = options.registry.endsWith("/")
    ? options.registry
    : options.registry + "/";

  // Try common file extensions
  let rawContent: Buffer | null = null;
  let fileExt = ".mjs";
  for (const ext of [".mjs", ".ts", ".js"]) {
    try {
      rawContent = await fetchBuffer(
        `${registryBase}capabilities/${id}/${resolvedVersion}/${id}${ext}`,
      );
      fileExt = ext;
      break;
    } catch {
      // Try next extension
    }
  }

  if (rawContent === null) {
    throw new Error(
      `Could not fetch capability file for ${id}@${resolvedVersion} from registry`,
    );
  }

  // SHA verification
  if (!options.noVerify) {
    const computedSha = sha256(rawContent);
    if (computedSha !== versionData.sha256) {
      throw new Error(
        `SHA verification failed: ${id}@${resolvedVersion}\n` +
          `   Expected:  ${versionData.sha256}\n` +
          `   Received:  ${computedSha}\n\n` +
          `   The source file has been modified since this version was registered.\n` +
          `   Do not install. Report at: github.com/routecraftjs/routecraft-registry/issues\n\n` +
          `   To install anyway: pnpm craft add ${id} --no-verify`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `\u26A0\uFE0F  SHA verification skipped.\n   Only use --no-verify with sources you have personally reviewed.\n`,
    );
  }

  // Write file (raw bytes to preserve exact content)
  const targetDir = resolve(options.dir);
  mkdirSync(targetDir, { recursive: true });
  const targetFile = join(targetDir, `${id}${fileExt}`);
  writeFileSync(targetFile, rawContent);

  const suffix = parentId ? `  (required by ${parentId})` : "";
  // eslint-disable-next-line no-console
  console.log(
    `\u2713  ${id}@${resolvedVersion} \u2192 ${basename(targetDir)}/${id}${fileExt}${suffix}`,
  );

  installed.set(id, resolvedVersion);

  // Collect dependencies
  if (versionData.dependencies) {
    Object.assign(allDeps, versionData.dependencies);
  }

  // Collect env vars
  if (versionData.env) {
    allEnvVars.push(...versionData.env);
  }

  return { envVars: allEnvVars, installedDeps: allDeps };
}

/**
 * Update index.ts to include the new capability import.
 *
 * Only handles simple single-line `export default [...]` patterns.
 * Falls back to printing manual instructions for complex exports.
 */
function updateIndexTs(dir: string, ids: string[]): void {
  // Look for index.ts in the parent of the capabilities dir
  const parentDir = resolve(dir, "..");
  const indexPath = join(parentDir, "index.ts");

  if (!existsSync(indexPath)) {
    // eslint-disable-next-line no-console
    console.log(`\n   index.ts not found at ${indexPath}. Add manually:`);
    for (const id of ids) {
      const importName = toImportName(id);
      // eslint-disable-next-line no-console
      console.log(`   import ${importName} from './capabilities/${id}.mjs'`);
    }
    return;
  }

  try {
    let content = readFileSync(indexPath, "utf-8");

    for (const id of ids) {
      const importName = toImportName(id);
      const importLine = `import ${importName} from './capabilities/${id}.mjs'`;

      // Skip if already imported
      if (content.includes(importName)) {
        continue;
      }

      // Match simple single-line export default [...] only
      const exportMatch = content.match(/export\s+default\s+\[([^\]]*)\]/s);
      if (exportMatch) {
        // Add import before the export
        const exportIndex = content.lastIndexOf("export default");
        content =
          content.slice(0, exportIndex) +
          `// Appended by craft add:\n${importLine}\n\n` +
          content.slice(exportIndex);

        // Add to the export array
        const currentExports = exportMatch[1]!.trim();
        const newExports = currentExports
          ? `${currentExports}, ${importName}`
          : importName;
        content = content.replace(
          /export\s+default\s+\[([^\]]*)\]/s,
          `export default [${newExports}]`,
        );
      } else {
        // Could not parse export, append at end
        content += `\n// Appended by craft add:\n${importLine}\n`;
        // eslint-disable-next-line no-console
        console.log(
          `   Could not parse export in index.ts. Added import but you may need to add ${importName} to your default export array manually.`,
        );
      }
    }

    writeFileSync(indexPath, content, "utf-8");
    // eslint-disable-next-line no-console
    console.log(`\u2713  index.ts updated`);
  } catch {
    // eslint-disable-next-line no-console
    console.log(`\n   Could not update index.ts automatically. Add manually:`);
    for (const id of ids) {
      const importName = toImportName(id);
      // eslint-disable-next-line no-console
      console.log(`   import ${importName} from './capabilities/${id}.mjs'`);
    }
  }
}

/**
 * Download a capability from the registry, verify its SHA-256, install
 * dependencies, and optionally update index.ts.
 *
 * @param specifier - Capability id or id@version (e.g. "elastic-logs@1.0.0")
 * @param options - Registry URL, target directory, and verification flags
 *
 * @example
 * ```ts
 * await addCommand("elastic-logs@1.0.0", { dir: "./capabilities" });
 * ```
 */
export async function addCommand(
  specifier: string,
  options: Partial<AddOptions>,
): Promise<void> {
  const { id, version } = parseSpecifier(specifier);
  const registryUrl = options.registry ?? DEFAULT_REGISTRY;
  const dir = options.dir ?? join(process.cwd(), "capabilities");

  // Block unofficial registries unless explicitly allowed
  if (!isOfficialRegistry(registryUrl) && !options.allowUnofficial) {
    throw new Error(
      `Unofficial registry: ${registryUrl}\n\n` +
        `   Only official Routecraft registries are allowed by default.\n` +
        `   If you trust this registry, re-run with --allow-unofficial:\n\n` +
        `     pnpm craft add ${specifier} --registry ${registryUrl} --allow-unofficial`,
    );
  }

  const addOpts: AddOptions = {
    registry: registryUrl,
    dir,
    noIndex: options.noIndex ?? false,
    noVerify: options.noVerify ?? false,
    allowUnofficial: options.allowUnofficial ?? false,
  };

  // Fetch registry
  const registryBase = registryUrl.endsWith("/")
    ? registryUrl
    : registryUrl + "/";

  const registry = await fetchJson<RegistryJson>(
    `${registryBase}registry/capabilities.json`,
  );

  // Check if the entry exists and if its type is supported
  const entry = registry[id];
  if (!entry) {
    throw new Error(`Capability "${id}" not found in the registry.`);
  }

  const installed = new Map<string, string>();
  const result = await installCapability(
    id,
    version,
    registry,
    addOpts,
    installed,
    [],
  );

  // Install dependencies via pnpm (using execFileSync to avoid shell injection)
  if (Object.keys(result.installedDeps).length > 0) {
    const depList = Object.entries(result.installedDeps)
      .filter(([pkg]) => {
        if (!SAFE_PKG_RE.test(pkg)) {
          // eslint-disable-next-line no-console
          console.warn(`\u26A0  Skipping invalid package name: ${pkg}`);
          return false;
        }
        return true;
      })
      .map(([pkg, ver]) => `${pkg}@${ver}`);

    if (depList.length > 0) {
      try {
        // eslint-disable-next-line no-console
        console.log("");
        execFileSync("pnpm", ["add", ...depList], {
          stdio: "inherit",
          cwd: resolve(dir, ".."),
        });
        // eslint-disable-next-line no-console
        console.log(`\u2713  dependencies installed`);
      } catch {
        // eslint-disable-next-line no-console
        console.warn(
          `\u26A0  Failed to install dependencies. Run manually:\n   pnpm add ${depList.join(" ")}`,
        );
      }
    }
  }

  // Update index.ts
  if (!addOpts.noIndex) {
    const installedIds = [...installed.keys()];
    updateIndexTs(dir, installedIds);
  }

  // Print required env vars
  if (result.envVars.length > 0) {
    const unique = [...new Set(result.envVars)];
    // eslint-disable-next-line no-console
    console.log(`\n   Required env vars:`);
    for (const v of unique) {
      // eslint-disable-next-line no-console
      console.log(`     ${v}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("");
}

// Export internals for testing
export const _test = {
  latestVersion,
  toImportName,
  parseSpecifier,
  checkCircularDeps,
  sha256,
  isOfficialRegistry,
  SAFE_PKG_RE,
} as const;
