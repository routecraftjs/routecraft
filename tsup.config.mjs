import { defineConfig } from "tsup";

export default defineConfig({
  // Input
  entry: ["index.ts"],

  // Output configuration
  clean: true,
  dts: true,
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,

  // Optimization
  minify: true,
  splitting: true,
  treeshake: true,

  // Node.js specific
  target: "node20",
  platform: "node",

  // External packages that shouldn't be bundled
  external: [
    // Node.js built-ins
    /^node:/,
    // Workspace packages (let them be resolved at runtime)
    /^@routecraft\/.*/,
  ],

  // Development
  watch: process.env["NODE_ENV"] === "development",

  // Optional: Bundle analysis
  // analyze: true,
});
