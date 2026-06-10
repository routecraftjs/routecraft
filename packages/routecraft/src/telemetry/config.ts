import { registerConfigApplier } from "../config-applier.ts";
import { telemetry } from "./index.ts";
import type { TelemetryOptions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Telemetry plugin configuration (SQLite, OpenTelemetry) */
    telemetry?: TelemetryOptions;
  }
}

/**
 * Register the `telemetry` config key so `defineConfig({ telemetry: {...} })`
 * is equivalent to `defineConfig({ plugins: [telemetry({...})] })`. Loaded
 * as a side-effect import from `packages/routecraft/src/index.ts`. Keeps
 * the core context free of telemetry plugin knowledge.
 */
registerConfigApplier("telemetry", (options) => telemetry(options));
