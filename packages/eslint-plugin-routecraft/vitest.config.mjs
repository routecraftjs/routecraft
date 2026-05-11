import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
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
