import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@routecraftjs/routecraft": new URL("./src/mod.ts", import.meta.url)
        .pathname,
      routecraft: new URL("./src/mod.ts", import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
