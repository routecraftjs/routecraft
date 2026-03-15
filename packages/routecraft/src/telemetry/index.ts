export { telemetry } from "./plugin.ts";
export { SqliteTelemetrySink } from "./sqlite-sink.ts";
export type {
  TelemetrySink,
  TelemetryOptions,
  SqliteSinkOptions,
  TelemetryEvent,
  TelemetryRoute,
  TelemetryExchange,
} from "./types.ts";
export {
  ALL_DDL,
  CREATE_EVENTS_TABLE,
  CREATE_ROUTES_TABLE,
  CREATE_EXCHANGES_TABLE,
} from "./schema.ts";
