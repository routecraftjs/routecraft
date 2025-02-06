import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      routecraft: new URL("../packages/routecraft/src/mod.ts", import.meta.url)
        .pathname,
      "@routecraft/core": new URL(
        "../packages/core/src/mod.ts",
        import.meta.url,
      ).pathname,
      "@routecraft/dsl": new URL("../packages/dsl/src/mod.ts", import.meta.url)
        .pathname,
      "@routecraft/adapters": new URL(
        "../packages/adapters/src/mod.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
