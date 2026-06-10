import { registerConfigApplier } from "../../config-applier";
import { httpPlugin } from "./plugin";
import type { HttpConfig } from "../../adapters/http/types";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** HTTP server config for inbound http() sources (port, auth, etc.) */
    http?: HttpConfig;
  }
}

/**
 * Register the `http` config key so `defineConfig({ http: {...} })` is
 * equivalent to `defineConfig({ plugins: [httpPlugin({...})] })`. Loaded as
 * a side-effect import from `packages/routecraft/src/index.ts` so users do
 * not have to wire it manually.
 */
registerConfigApplier("http", (options) => httpPlugin(options));
