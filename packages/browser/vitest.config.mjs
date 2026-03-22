import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@routecraft/browser": new URL("./src/index.ts", import.meta.url)
        .pathname,
      "@routecraft/testing": new URL("../testing/src/index.ts", import.meta.url)
        .pathname,
      "@routecraft/routecraft": new URL(
        "../routecraft/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
    environment: "node",
  },
});
