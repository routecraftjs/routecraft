import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@routecraft/testing": new URL("../testing/src/index.ts", import.meta.url)
        .pathname,
      "@routecraft/routecraft": new URL("./src/index.ts", import.meta.url)
        .pathname,
      routecraft: new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    env: {
      LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
