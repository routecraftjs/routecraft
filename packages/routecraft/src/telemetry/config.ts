import { registerConfigApplier } from "../config-applier.ts";
import { telemetryPlugin } from "./index.ts";
import type { TelemetryOptions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Telemetry plugin configuration (SQLite, OpenTelemetry) */
    telemetry?: TelemetryOptions;
  }
}

/**
 * Register the `telemetry` config key so `defineProject({ telemetry: {...} })`
 * is equivalent to `defineProject({ plugins: [telemetryPlugin({...})] })`. Loaded
 * as a side-effect import from `packages/routecraft/src/index.ts`. Keeps
 * the core context free of telemetry plugin knowledge.
 */
registerConfigApplier("telemetry", (options) => telemetryPlugin(options));
