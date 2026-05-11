import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@routecraft/testing": new URL("./src/index.ts", import.meta.url)
        .pathname,
      "@routecraft/routecraft": new URL(
        "../routecraft/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
    exclude: [
      ...configDefaults.exclude,
      "**/*.bun.test.ts",
      "**/*.bun.test.tsx",
    ],
  },
});
