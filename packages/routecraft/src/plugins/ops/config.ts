import { registerConfigApplier } from "../../config-applier";
import { opsPlugin } from "./plugin";
import type { OpsConfig } from "./types";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Operational surface: health endpoints, and later the action namespace. */
    ops?: OpsConfig;
  }
}

/**
 * Register the `ops` config key so `defineConfig({ ops: {...} })` is
 * equivalent to `defineConfig({ plugins: [opsPlugin({...})] })`. Loaded as a
 * side-effect import from `packages/routecraft/src/index.ts` so users do not
 * have to wire it manually.
 */
registerConfigApplier("ops", (options) => opsPlugin(options));
