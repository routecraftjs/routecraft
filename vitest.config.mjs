import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
    alias: {
      "@routecraft/core": "/packages/core/src/mod.ts",
      "@routecraft/dsl": "/packages/dsl/src/mod.ts",
      "@routecraft/adapters": "/packages/adapters/src/mod.ts",
    },
  },
});
