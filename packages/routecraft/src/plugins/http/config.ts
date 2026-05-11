import { registerConfigApplier } from "../../config-applier";
import { httpPlugin } from "./plugin";

/**
 * Register the `http` config key so `defineConfig({ http: {...} })` is
 * equivalent to `defineConfig({ plugins: [httpPlugin({...})] })`. Loaded as
 * a side-effect import from `packages/routecraft/src/index.ts` so users do
 * not have to wire it manually.
 */
registerConfigApplier("http", (options) => httpPlugin(options));
