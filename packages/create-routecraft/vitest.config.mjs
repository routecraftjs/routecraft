import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
    exclude: [...configDefaults.exclude, "**/templates/**"],
    environment: "node",
  },
});
