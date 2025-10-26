import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  dts: true,
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  minify: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  platform: "node",
});
