import { readFileSync } from "node:fs";

/**
 * Reads peer and optional dependency names from a package.json file
 * so size-limit excludes them from the bundle measurement.
 */
function readExternals(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return [
    ...new Set([
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]),
  ];
}

/** Node built-ins should never count toward bundle size. */
const nodeBuiltins = ["node:*"];

/**
 * Bun built-in module specifiers that are loaded via dynamic import in the
 * library (e.g. `bun:sqlite` for the telemetry sink). They have no on-disk
 * resolution and must be marked external for esbuild measurement.
 */
const bunBuiltins = ["bun:sqlite"];

function makeNodeEsmConfig(name, path, limit, pkgJsonPath) {
  const pkgExternals = readExternals(pkgJsonPath);
  return {
    name,
    path,
    limit,
    running: false,
    modifyEsbuildConfig(config) {
      config.platform = "node";
      config.format = "esm";
      config.external = [
        ...(config.external || []),
        ...nodeBuiltins,
        ...bunBuiltins,
        ...pkgExternals,
      ];
      return config;
    },
  };
}

export default [
  makeNodeEsmConfig(
    "@routecraft/routecraft",
    "packages/routecraft/dist/index.js",
    "100 kb",
    "packages/routecraft/package.json",
  ),
  makeNodeEsmConfig(
    "@routecraft/ai",
    "packages/ai/dist/index.js",
    "200 kb",
    "packages/ai/package.json",
  ),
  makeNodeEsmConfig(
    "@routecraft/os",
    "packages/os/dist/index.js",
    "100 kb",
    "packages/os/package.json",
  ),
  makeNodeEsmConfig(
    "@routecraft/testing",
    "packages/testing/dist/index.js",
    "100 kb",
    "packages/testing/package.json",
  ),
];
