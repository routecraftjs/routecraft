import { readFileSync } from "node:fs";

/**
 * Reads peer and optional dependency names from a package.json file
 * so size-limit excludes them from the bundle measurement.
 */
function readExternals(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return [
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];
}

/** Node built-ins should never count toward bundle size. */
const nodeBuiltins = ["node:*"];

export default [
  {
    name: "@routecraft/routecraft",
    path: "packages/routecraft/dist/index.js",
    limit: "100 kb",
    running: false,
    modifyEsbuildConfig(config) {
      config.platform = "node";
      config.format = "esm";
      config.external = [
        ...(config.external || []),
        ...nodeBuiltins,
        ...readExternals("packages/routecraft/package.json"),
      ];
      return config;
    },
  },
  {
    name: "@routecraft/ai",
    path: "packages/ai/dist/index.js",
    limit: "150 kb",
    running: false,
    modifyEsbuildConfig(config) {
      config.platform = "node";
      config.format = "esm";
      config.external = [
        ...(config.external || []),
        ...nodeBuiltins,
        ...readExternals("packages/ai/package.json"),
      ];
      return config;
    },
  },
  {
    name: "@routecraft/browser",
    path: "packages/browser/dist/index.js",
    limit: "100 kb",
    running: false,
    modifyEsbuildConfig(config) {
      config.platform = "node";
      config.format = "esm";
      config.external = [
        ...(config.external || []),
        ...nodeBuiltins,
        ...readExternals("packages/browser/package.json"),
      ];
      return config;
    },
  },
  {
    name: "@routecraft/testing",
    path: "packages/testing/dist/index.js",
    limit: "100 kb",
    running: false,
    modifyEsbuildConfig(config) {
      config.platform = "node";
      config.format = "esm";
      config.external = [
        ...(config.external || []),
        ...nodeBuiltins,
        ...readExternals("packages/testing/package.json"),
      ];
      return config;
    },
  },
];
