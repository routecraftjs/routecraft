/**
 * craft add -- download a capability from the registry, verify its SHA,
 * install dependencies, and optionally update index.ts.
 */

import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/routecraftjs/routecraft-registry/refs/heads/main/";

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
}

/**
 * Resolve the latest version from a registry entry.
 */
function latestVersion(entry: RegistryEntry): string {
  const versions = Object.keys(entry.versions).sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  });
  return versions[versions.length - 1]!;
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
 * Fetch JSON from a URL with basic retry.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch text content from a URL.
 */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
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
 */
async function installCapability(
  id: string,
  version: string | undefined,
  registry: RegistryJson,
  options: AddOptions,
  installed: Set<string>,
  chain: string[],
  parentId?: string,
): Promise<{ envVars: string[]; installedDeps: Record<string, string> }> {
  const entry = registry[id];
  if (!entry) {
    throw new Error(
      `Capability "${id}" not found in the registry. Check the id and try again.`,
    );
  }

  const resolvedVersion = version ?? latestVersion(entry);
  const versionData = entry.versions[resolvedVersion];
  if (!versionData) {
    const available = Object.keys(entry.versions).join(", ");
    throw new Error(
      `Version "${resolvedVersion}" of "${id}" not found. Available: ${available}`,
    );
  }

  const key = `${id}@${resolvedVersion}`;

  // Skip if already installed in this session
  if (installed.has(key)) {
    return { envVars: [], installedDeps: {} };
  }

  // Circular dependency check
  checkCircularDeps(id, resolvedVersion, chain);

  // Check type -- only capabilities supported for now
  // We infer from which registry JSON we are using (capabilities.json)
  // Agent/skill types will be handled when those features ship

  // Install required capabilities first (recursive)
  const allEnvVars: string[] = [];
  const allDeps: Record<string, string> = {};

  if (versionData.requiredCapabilities) {
    for (const reqSpec of versionData.requiredCapabilities) {
      const { id: reqId, version: reqVersion } = parseSpecifier(reqSpec);
      const result = await installCapability(
        reqId,
        reqVersion,
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
  let content: string | null = null;
  let fileExt = ".mjs";
  for (const ext of [".mjs", ".ts", ".js"]) {
    try {
      content = await fetchText(
        `${registryBase}capabilities/${id}/${resolvedVersion}/${id}${ext}`,
      );
      fileExt = ext;
      break;
    } catch {
      // Try next extension
    }
  }

  if (content === null) {
    throw new Error(
      `Could not fetch capability file for ${id}@${resolvedVersion} from registry`,
    );
  }

  // SHA verification
  if (!options.noVerify) {
    const computedSha = sha256(content);
    if (computedSha !== versionData.sha256) {
      // eslint-disable-next-line no-console
      console.error(`
\u2717  SHA verification failed: ${id}@${resolvedVersion}
   Expected:  ${versionData.sha256}
   Received:  ${computedSha}

   The source file has been modified since this version was registered.
   Do not install. Report at: github.com/routecraftjs/routecraft-registry/issues

   To install anyway: pnpm craft add ${id} --no-verify
`);
      process.exit(1);
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `\u26A0\uFE0F  SHA verification skipped.\n   Only use --no-verify with sources you have personally reviewed.\n`,
    );
  }

  // Write file
  const targetDir = resolve(options.dir);
  mkdirSync(targetDir, { recursive: true });
  const targetFile = join(targetDir, `${id}${fileExt}`);
  writeFileSync(targetFile, content, "utf-8");

  const suffix = parentId ? `  (required by ${parentId})` : "";
  // eslint-disable-next-line no-console
  console.log(
    `\u2713  ${id}@${resolvedVersion} \u2192 ${basename(targetDir)}/${id}${fileExt}${suffix}`,
  );

  installed.add(key);

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

      // Append import before the last export or at end
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

export async function addCommand(
  specifier: string,
  options: {
    registry?: string;
    dir?: string;
    noIndex?: boolean;
    noVerify?: boolean;
  },
): Promise<void> {
  const { id, version } = parseSpecifier(specifier);
  const registryUrl = options.registry ?? DEFAULT_REGISTRY;
  const dir = options.dir ?? join(process.cwd(), "capabilities");

  const addOpts: AddOptions = {
    registry: registryUrl,
    dir,
    noIndex: options.noIndex ?? false,
    noVerify: options.noVerify ?? false,
  };

  // Fetch registry
  const registryBase = registryUrl.endsWith("/")
    ? registryUrl
    : registryUrl + "/";

  let registry: RegistryJson;
  try {
    registry = await fetchJson<RegistryJson>(
      `${registryBase}registry/capabilities.json`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to fetch registry from ${registryBase}registry/capabilities.json`,
    );
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Check if the entry exists and if its type is supported
  const entry = registry[id];
  if (!entry) {
    // eslint-disable-next-line no-console
    console.error(`Capability "${id}" not found in the registry.`);
    process.exit(1);
  }

  const installed = new Set<string>();
  const result = await installCapability(
    id,
    version,
    registry,
    addOpts,
    installed,
    [],
  );

  // Install dependencies via pnpm
  if (Object.keys(result.installedDeps).length > 0) {
    const depArgs = Object.entries(result.installedDeps)
      .map(([pkg, ver]) => `${pkg}@${ver}`)
      .join(" ");
    try {
      // eslint-disable-next-line no-console
      console.log("");
      execSync(`pnpm add ${depArgs}`, {
        stdio: "inherit",
        cwd: resolve(dir, ".."),
      });
      // eslint-disable-next-line no-console
      console.log(`\u2713  dependencies installed`);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `\u26A0  Failed to install dependencies. Run manually:\n   pnpm add ${depArgs}`,
      );
    }
  }

  // Update index.ts
  if (!addOpts.noIndex) {
    const installedIds = [...installed].map((k) => k.split("@")[0]!);
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
