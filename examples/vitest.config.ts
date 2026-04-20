import dotenv from "dotenv";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Test env comes from `.env.example`: contributors already copy it to
// `.env` to run the examples, so reusing the same fakes keeps one source
// of truth. The plugin init in craft.config.ts validates some of these at
// module-import time (e.g. JWT_SECRET via mcpPlugin -> jwt), which is why
// the tests need any value at all — the mocked adapters bypass the real
// clients at runtime.
const { parsed: envExample = {} } = dotenv.config({
  path: new URL("./.env.example", import.meta.url),
  processEnv: {},
});

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
      ...envExample,
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
    },
  },
});
