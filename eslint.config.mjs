import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import testCaseDoc from "./.eslint-rules/test-case-doc.mjs";
import eslintConfigPrettier from "eslint-config-prettier";
import routecraftPlugin from "./packages/eslint-plugin-routecraft/src/index.ts";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      ".husky/_/**",
      "pnpm-lock.yaml",
      "**/.next/**",
      "apps/routecraft.dev/**",
      ".github/scripts/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // General rules
      "no-console": "error",
      "prefer-const": "warn",
      // Defer formatting to Prettier
      quotes: "off",
      semi: "off",
      "comma-dangle": "off",
      // Bun restriction
      "no-restricted-globals": [
        "error",
        {
          name: "Bun",
          message: "Avoid using Bun-specific APIs for Node.js compatibility",
        },
      ],
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  // RouteCraft rules only for examples
  {
    files: ["examples/**/*.{js,mjs}"],
    plugins: { "@routecraft/routecraft": routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
  {
    files: ["**/*.test.{js,ts,mjs,cjs}", "**/*.spec.{js,ts,mjs,cjs}"],
    plugins: {
      custom: {
        rules: {
          "test-case-doc": testCaseDoc,
        },
      },
    },
    rules: {
      // Relaxed rules for test files
      "@typescript-eslint/no-explicit-any": "off",
      "custom/test-case-doc": "error",
    },
  },
  // Disable formatting-related rules that might conflict with Prettier
  eslintConfigPrettier,
];
