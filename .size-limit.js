export default [
  {
    path: "packages/routecraft/dist/index.js",
    limit: "100 kb",
    running: false,
    modifyEsbuildConfig(config) {
      // Configure esbuild for Node.js environment
      // This tells esbuild that node:* modules are built-in and shouldn't be resolved
      config.platform = "node";
      config.external = [...(config.external || []), "node:*"];
      return config;
    },
  },
];
