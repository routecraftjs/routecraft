import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    projects: ["packages/*", "examples"],
    exclude: configDefaults.exclude,
  },
});
