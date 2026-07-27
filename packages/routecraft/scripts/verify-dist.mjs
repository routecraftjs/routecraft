/**
 * Post-build guard for the config-applier registrations (issue #423).
 *
 * The first-class config keys (`http`, `cron`, `direct`, `mail`, `carddav`,
 * `telemetry`) are wired through bare side-effect imports in `src/index.ts`.
 * Side-effect imports are exactly what packaging misconfiguration silently
 * drops: a `sideEffects` allowlist in package.json that omits the src config
 * modules made esbuild prune all of them from the published bundles, so
 * `defineConfig({ mail: {...} })` typechecked but did nothing at runtime.
 *
 * This script derives the expected applier keys from the source (any
 * `registerConfigApplier("key", ...)` call under `src/`), imports the built
 * bundle, and asserts every key is present in the live registry. Run once
 * per output format: `bun scripts/verify-dist.mjs esm|cjs`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath (not URL.pathname) so the root is a real filesystem path
// on every platform; the dist import below converts back to a file URL,
// which the ESM loader requires for absolute specifiers on Windows.
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function collectSourceKeys(dir, keys = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceKeys(path, keys);
    } else if (entry.name.endsWith(".ts")) {
      const source = readFileSync(path, "utf8");
      // Anchored to line start so indented JSDoc examples do not match;
      // real registrations are top-level statements.
      for (const match of source.matchAll(
        /^registerConfigApplier\(\s*"([^"]+)"/gm,
      )) {
        keys.add(match[1]);
      }
    }
  }
  return keys;
}

const expected = [...collectSourceKeys(join(pkgRoot, "src"))].sort();
if (expected.length === 0) {
  console.error(
    "verify-dist: found no registerConfigApplier() calls under src/; the scan is broken.",
  );
  process.exit(1);
}

const mode = process.argv[2] ?? "esm";
const entry = mode === "cjs" ? "dist/index.cjs" : "dist/index.js";
await import(pathToFileURL(join(pkgRoot, entry)).href);

const registry = globalThis[Symbol.for("routecraft.config-applier-registry")];
const missing = expected.filter((key) => !registry?.has(key));
if (missing.length > 0) {
  console.error(
    `verify-dist: ${entry} does not register config applier(s): ${missing.join(", ")}. ` +
      "The side-effect imports in src/index.ts were tree-shaken out of the bundle " +
      "(check the tsup config and any package.json sideEffects field).",
  );
  process.exit(1);
}

console.log(
  `verify-dist: ${entry} registers ${expected.length} config appliers (${expected.join(", ")}).`,
);
process.exit(0);
