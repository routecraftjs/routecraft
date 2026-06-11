/**
 * Root Prettier config for the Routecraft monorepo.
 *
 * The Routecraft plugin is loaded straight from TypeScript source (the same
 * way eslint.config.mjs loads the ESLint plugin) so `bun run format` works on
 * a fresh checkout without a build step. Format scripts run under the Bun
 * runtime, which transpiles the `.ts` entry on import.
 */
export default {
  plugins: ["./packages/prettier-plugin-routecraft/src/index.ts"],
};
