import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      routecraft: new URL("../routecraft/src/mod.ts", import.meta.url).pathname,
      "@routecraft/core": new URL("../core/src/mod.ts", import.meta.url)
        .pathname,
      "@routecraft/dsl": new URL("../dsl/src/mod.ts", import.meta.url).pathname,
      "@routecraft/adapters": new URL("../adapters/src/mod.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
