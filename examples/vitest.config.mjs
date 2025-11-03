import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@routecraft/routecraft": new URL(
        "../packages/routecraft/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    env: {
      LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
