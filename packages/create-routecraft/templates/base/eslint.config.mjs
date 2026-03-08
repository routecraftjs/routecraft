import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import routecraftPlugin from "@routecraft/eslint-plugin-routecraft";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "capabilities/**/*.{ts,js}",
      "adapters/**/*.{ts,js}",
      "plugins/**/*.{ts,js}",
      "index.{ts,js}",
    ],
    plugins: { "@routecraft/routecraft": routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
];
