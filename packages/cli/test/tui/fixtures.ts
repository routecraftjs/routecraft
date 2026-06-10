import { Database } from "bun:sqlite";
import type {
  RouteSummary,
  ExchangeRecord,
  EventRecord,
} from "../../src/tui/types.js";

/**
 * Seed a telemetry database with the routes/exchanges/events the TUI
 * reads, including the agent/tool event stream the Agents and Tools tabs
 * derive from. Mirrors what the core and AI packages emit (with snapshot
 * capture on, so tool input/output are present).
 */
export function seedTelemetryDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    context_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    details TEXT NOT NULL,
    exchange_id TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE exchanges (
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
  )`);
  db.exec(`CREATE TABLE routes (
    id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    status TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (id, context_id)
  )`);

  const ev = db.prepare(
    "INSERT INTO events (timestamp, context_id, event_name, details, exchange_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const emit = (
    ts: string,
    name: string,
    details: Record<string, unknown>,
    exchangeId: string | null,
  ): void => {
    ev.run(ts, "ctx", name, JSON.stringify(details), exchangeId, exchangeId);
  };

  db.prepare(
    "INSERT INTO routes (id, context_id, status, registered_at) VALUES (?, ?, ?, ?)",
  ).run("r1", "ctx", "started", "2026-06-05T10:00:00.000Z");

  // A registered agent that never ran.
  emit(
    "2026-06-05T10:00:00.000Z",
    "agent:registered",
    {
      agentId: "summariser",
      description: "Summarises documents",
      model: "anthropic:claude-opus-4-7",
      source: "registered",
    },
    null,
  );
  // A registered tool.
  emit(
    "2026-06-05T10:00:00.000Z",
    "agent:tool:registered",
    { toolName: "search", description: "Search the web", source: "registered" },
    null,
  );

  // A by-name agent run (researcher) with one tool call.
  emit(
    "2026-06-05T10:01:00.000Z",
    "route:agent:started",
    {
      routeId: "r1",
      exchangeId: "ex1",
      agentName: "researcher",
      model: "anthropic:claude-opus-4-7",
      toolNames: ["search"],
      maxTurns: 20,
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:01.000Z",
    "route:agent:tool:invoked",
    {
      routeId: "r1",
      exchangeId: "ex1",
      toolCallId: "c1",
      toolName: "search",
      _snapshot: { input: { q: "hello" } },
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:02.000Z",
    "route:agent:tool:result",
    {
      routeId: "r1",
      exchangeId: "ex1",
      toolCallId: "c1",
      toolName: "search",
      _snapshot: { output: "a result" },
      duration: 5,
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:03.000Z",
    "route:agent:finished",
    {
      routeId: "r1",
      exchangeId: "ex1",
      agentName: "researcher",
      model: "anthropic:claude-opus-4-7",
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    },
    "ex1",
  );

  // An inline agent run (keyed by route) that errored.
  emit(
    "2026-06-05T10:02:00.000Z",
    "route:agent:started",
    { routeId: "r2", exchangeId: "ex2", model: "anthropic:claude-haiku-4-5" },
    "ex2",
  );
  emit(
    "2026-06-05T10:02:01.000Z",
    "route:agent:error",
    { routeId: "r2", exchangeId: "ex2", model: "anthropic:claude-haiku-4-5" },
    "ex2",
  );

  // A second inline run with tool errors: one persisted with snapshot
  // capture OFF (errorName only, no _snapshot), and one in the legacy
  // pre-envelope shape (top-level error).
  emit(
    "2026-06-05T10:03:00.000Z",
    "route:agent:started",
    {
      routeId: "r3",
      exchangeId: "ex3",
      model: "anthropic:claude-haiku-4-5",
      toolNames: ["fetch"],
      maxTurns: 20,
    },
    "ex3",
  );
  emit(
    "2026-06-05T10:03:01.000Z",
    "route:agent:tool:invoked",
    { routeId: "r3", exchangeId: "ex3", toolCallId: "c2", toolName: "fetch" },
    "ex3",
  );
  emit(
    "2026-06-05T10:03:02.000Z",
    "route:agent:tool:error",
    {
      routeId: "r3",
      exchangeId: "ex3",
      toolCallId: "c2",
      toolName: "fetch",
      errorName: "TypeError",
      duration: 3,
    },
    "ex3",
  );
  emit(
    "2026-06-05T10:03:03.000Z",
    "route:agent:tool:error",
    {
      routeId: "r3",
      exchangeId: "ex3",
      toolCallId: "c3",
      toolName: "legacy",
      error: { name: "Error", message: "boom" },
      duration: 1,
    },
    "ex3",
  );

  const ex = db.prepare(
    "INSERT INTO exchanges (id, route_id, context_id, correlation_id, status, started_at, completed_at, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  ex.run(
    "ex1",
    "r1",
    "ctx",
    "ex1",
    "completed",
    "2026-06-05T10:01:00.000Z",
    "2026-06-05T10:01:03.000Z",
    3000,
    null,
  );
  ex.run(
    "ex2",
    "r2",
    "ctx",
    "ex2",
    "failed",
    "2026-06-05T10:02:00.000Z",
    null,
    null,
    "boom",
  );
  db.close();
}

/**
 * Create a RouteSummary with sensible defaults.
 */
export function makeRoute(overrides?: Partial<RouteSummary>): RouteSummary {
  return {
    id: "test-route",
    status: "started",
    totalExchanges: 10,
    completedExchanges: 8,
    failedExchanges: 1,
    droppedExchanges: 1,
    avgDurationMs: 42,
    ...overrides,
  };
}

/**
 * Create an ExchangeRecord with sensible defaults.
 */
export function makeExchange(
  overrides?: Partial<ExchangeRecord>,
): ExchangeRecord {
  return {
    id: "ex-00000001-0000-0000-0000-000000000001",
    routeId: "test-route",
    contextId: "ctx-001",
    correlationId: "cor-001",
    status: "completed",
    startedAt: "2026-03-20T10:00:00.000Z",
    completedAt: "2026-03-20T10:00:00.050Z",
    durationMs: 50,
    error: null,
    ...overrides,
  };
}

/**
 * Create an EventRecord with sensible defaults.
 */
export function makeEvent(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: 1,
    timestamp: "2026-03-20T10:00:00.000Z",
    contextId: "ctx-001",
    eventName: "route:exchange:started",
    details: JSON.stringify({
      routeId: "test-route",
      exchangeId: "ex-001",
      correlationId: "cor-001",
    }),
    ...overrides,
  };
}
