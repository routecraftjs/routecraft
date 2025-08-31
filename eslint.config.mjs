import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import testcaseDoc from "./.eslint-rules/testcase-doc.mjs";

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
      quotes: ["error", "double"],
      semi: ["error", "always"],
      "comma-dangle": ["error", "always-multiline"],
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
  {
    files: ["**/*.test.{js,ts,mjs,cjs}", "**/*.spec.{js,ts,mjs,cjs}"],
    plugins: {
      custom: {
        rules: {
          "testcase-doc": testcaseDoc,
        },
      },
    },
    rules: {
      // Relaxed rules for test files
      "@typescript-eslint/no-explicit-any": "off",
      "custom/testcase-doc": "error",
    },
  },
];
