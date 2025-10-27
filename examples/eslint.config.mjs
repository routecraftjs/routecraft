import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import routecraftPlugin from "@routecraftjs/eslint-plugin-routecraft";
import globals from "globals";

/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    plugins: { "@routecraftjs/routecraft": routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
  {
    files: ["**/*.test.{js,mjs,ts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
