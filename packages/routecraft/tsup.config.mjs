import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  platform: "node",
  external: ["cheerio", "agent-browser", "better-sqlite3"],
});
