import { registerConfigApplier } from "../../config-applier";
import { remotesPlugin } from "./plugin";
import type { RemotesConfig } from "./types";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Other running instances whose dispatchable routes become direct endpoints here. */
    remotes?: RemotesConfig;
  }
}

/**
 * Register the `remotes` config key so `defineConfig({ remotes: {...} })`
 * is equivalent to `defineConfig({ plugins: [remotesPlugin({...})] })`.
 * Loaded as a side-effect import from `packages/routecraft/src/index.ts`,
 * after the `ops` key, so an imported route's indicator has a ledger to
 * report into when the app carries an ops surface.
 */
registerConfigApplier("remotes", (options) => remotesPlugin(options));
