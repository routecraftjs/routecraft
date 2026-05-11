import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@routecraft/os": new URL("./src/index.ts", import.meta.url).pathname,
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
    exclude: [
      ...configDefaults.exclude,
      "**/*.bun.test.ts",
      "**/*.bun.test.tsx",
    ],
  },
});
