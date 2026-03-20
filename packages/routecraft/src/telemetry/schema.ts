/**
 * SQLite DDL statements for the telemetry database.
 *
 * Tables:
 * - events: All framework events (context, route, exchange, step, operation, plugin, error)
 * - routes: Route registration and lifecycle tracking
 * - exchanges: Exchange lifecycle tracking with duration and error info
 */

/** Create the events table for storing all framework events. */
export const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  context_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  details TEXT NOT NULL,
  exchange_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** Create the routes table for tracking route lifecycle. */
export const CREATE_ROUTES_TABLE = `
CREATE TABLE IF NOT EXISTS routes (
  id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  PRIMARY KEY (id, context_id)
)`;

/** Create the exchanges table for tracking exchange lifecycle. */
export const CREATE_EXCHANGES_TABLE = `
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  PRIMARY KEY (id, context_id)
)`;

/** Index on events.event_name for filtered queries. */
export const CREATE_EVENTS_EVENT_NAME_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_event_name ON events(event_name)`;

/** Index on events.context_id for context-scoped queries. */
export const CREATE_EVENTS_CONTEXT_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_context_id ON events(context_id)`;

/** Index on exchanges.route_id for route-scoped queries. */
export const CREATE_EXCHANGES_ROUTE_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_exchanges_route_id ON exchanges(route_id)`;

/** Index on exchanges.status for filtered queries. */
export const CREATE_EXCHANGES_STATUS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_exchanges_status ON exchanges(status)`;

/** Index on exchanges.started_at for time-bucketed queries. */
export const CREATE_EXCHANGES_STARTED_AT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_exchanges_started_at ON exchanges(started_at)`;

/** Composite index on exchanges(route_id, started_at) for per-route time queries. */
export const CREATE_EXCHANGES_ROUTE_STARTED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_exchanges_route_started ON exchanges(route_id, started_at)`;

/** Index on exchanges.correlation_id for correlation chain lookups. */
export const CREATE_EXCHANGES_CORRELATION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_exchanges_correlation_id ON exchanges(correlation_id)`;

/** Index on events.exchange_id for exchange-scoped event lookups. */
export const CREATE_EVENTS_EXCHANGE_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_exchange_id ON events(exchange_id)`;

/** Index on events.correlation_id for correlation chain event lookups. */
export const CREATE_EVENTS_CORRELATION_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON events(correlation_id)`;

/** All DDL statements in execution order. */
export const ALL_DDL = [
  CREATE_EVENTS_TABLE,
  CREATE_ROUTES_TABLE,
  CREATE_EXCHANGES_TABLE,
  CREATE_EVENTS_EVENT_NAME_INDEX,
  CREATE_EVENTS_CONTEXT_ID_INDEX,
  CREATE_EXCHANGES_ROUTE_ID_INDEX,
  CREATE_EXCHANGES_STATUS_INDEX,
  CREATE_EXCHANGES_STARTED_AT_INDEX,
  CREATE_EXCHANGES_ROUTE_STARTED_INDEX,
  CREATE_EXCHANGES_CORRELATION_INDEX,
  CREATE_EVENTS_EXCHANGE_ID_INDEX,
  CREATE_EVENTS_CORRELATION_ID_INDEX,
] as const;
