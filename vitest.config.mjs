import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
  resolve: {
    alias: {
      "@routecraft/core": "/packages/core/mod.ts",
      "@routecraft/dsl": "/packages/dsl/mod.ts",
      "@routecraft/adapters": "/packages/adapters/mod.ts",
      "@routecraft/cli": "/packages/cli/mod.ts",
    },
  },
});
