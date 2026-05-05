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
  // Optional peer deps must be marked external so they stay as runtime
  // imports (loaded lazily by the adapter) rather than getting inlined.
  // `bun:sqlite` is a Bun built-in, marked external so esbuild leaves it
  // untouched (the dynamic import resolves at runtime under Bun only).
  external: ["cheerio", "croner", "agent-browser", "bun:sqlite"],
});
