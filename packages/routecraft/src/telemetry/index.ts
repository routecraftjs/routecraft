export { telemetry } from "./plugin.ts";
export { SqliteSpanProcessor, ATTR, SPAN_KIND } from "./sqlite-processor.ts";
export { SqliteConnection } from "./sqlite-connection.ts";
export { SqliteEventWriter } from "./sqlite-event-writer.ts";
export type { TelemetryOptions, TelemetryEvent } from "./types.ts";
export {
  ALL_DDL,
  CREATE_EVENTS_TABLE,
  CREATE_ROUTES_TABLE,
  CREATE_EXCHANGES_TABLE,
} from "./schema.ts";
