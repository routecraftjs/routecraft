export default [
  {
    path: "packages/routecraft/dist/index.js",
    limit: "100 kb",
    running: false,
    modifyEsbuildConfig(config) {
      // Configure esbuild for Node.js environment
      config.platform = "node";
      config.format = "esm"; // so import.meta (e.g. createRequire(import.meta.url)) works
      config.external = [
        ...(config.external || []),
        "node:*",
        // Peer/optional: not bundled so size limit applies to core only
        "agent-browser",
        "pino-pretty",
        "playwright-core",
        "playwright",
        "cheerio",
      ];
      return config;
    },
  },
];
