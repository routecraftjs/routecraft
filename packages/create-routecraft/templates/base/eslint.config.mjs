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
  {
    // Test files legitimately mint principals as fixtures with
    // authenticate(); the restriction targets production mint sites. See
    // the "Principal minting is a sanctioned exception" section of the
    // linting docs for how to sanction a real channel authenticator.
    files: ["**/*.test.{ts,js}", "**/*.spec.{ts,js}"],
    rules: { "@routecraft/routecraft/restrict-principal-minting": "off" },
  },
];
