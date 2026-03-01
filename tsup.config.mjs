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
    /^node:/,
    /^@routecraft\/.*/,
    "pino-pretty",
    // @routecraft/ai optional: install only the providers/MCP/embeddings you use
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/openai",
    "@huggingface/transformers",
    "@modelcontextprotocol/sdk",
    "@openrouter/ai-sdk-provider",
    "ollama-ai-provider-v2",
  ],

  // Development
  watch: process.env["NODE_ENV"] === "development",

  // Optional: Bundle analysis
  // analyze: true,
});
