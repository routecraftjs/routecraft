import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@routecraft/testing": new URL(
        "../packages/testing/src/index.ts",
        import.meta.url,
      ).pathname,
      "@routecraft/routecraft": new URL(
        "../packages/routecraft/src/index.ts",
        import.meta.url,
      ).pathname,
      "@routecraft/ai": new URL("../packages/ai/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "node",
    env: {
      LOG_LEVEL: "silent",
      JWT_SECRET:
        "test-jwt-secret-for-example-tests-only-never-used-in-production",
      GEMINI_API_KEY: "test-gemini-key",
      OPENROUTER_API_KEY: "test-openrouter-key",
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
