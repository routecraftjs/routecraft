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

function makeNodeEsmConfig(name, path, limit, pkgJsonPath) {
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
        ...readExternals(pkgJsonPath),
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
    "150 kb",
    "packages/ai/package.json",
  ),
  makeNodeEsmConfig(
    "@routecraft/browser",
    "packages/browser/dist/index.js",
    "100 kb",
    "packages/browser/package.json",
  ),
  makeNodeEsmConfig(
    "@routecraft/testing",
    "packages/testing/dist/index.js",
    "100 kb",
    "packages/testing/package.json",
  ),
];
