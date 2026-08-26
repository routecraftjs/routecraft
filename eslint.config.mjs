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
      // Agent worktrees are nested checkouts of this repository. Linting one
      // reports every file in it a second time, against a config it did not
      // come from, and fails the parent repo's gate for changes that are not
      // the parent's. `.gitignore` does not cover this: flat config does not
      // read it.
      ".claude/**",
      ".husky/_/**",
      "bun.lock",
      "**/.next/**",
      "apps/routecraft.dev/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
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
  // Routecraft rules only for examples
  {
    files: ["examples/**/*.{js,mjs}"],
    plugins: { "@routecraft/routecraft": routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
  {
    files: ["**/*.test.{js,ts,tsx,mjs,cjs}", "**/*.spec.{js,ts,tsx,mjs,cjs}"],
    plugins: {
      custom: {
        rules: {
          "test-case-doc": testCaseDoc,
        },
      },
    },
    rules: {
      // Relaxed rules for test files, plus the JSDoc-on-every-test contract
      "@typescript-eslint/no-explicit-any": "off",
      "custom/test-case-doc": "error",
      "no-console": "off",
    },
  },
  {
    files: [
      ".github/scripts/**/*.{js,ts,mjs,cjs}",
      "scripts/**/*.{js,ts,mjs,cjs}",
      "packages/*/scripts/**/*.{js,ts,mjs,cjs}",
    ],
    rules: {
      // Relaxed rules for repo utility scripts
      "no-console": "off",
    },
  },
  // Disable formatting-related rules that might conflict with Prettier
  eslintConfigPrettier,
];
