import type {
  RouteSummary,
  ExchangeRecord,
  EventRecord,
} from "../../src/tui/types.js";

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
    eventName: "route:test-route:exchange:started",
    details: JSON.stringify({
      routeId: "test-route",
      exchangeId: "ex-001",
      correlationId: "cor-001",
    }),
    ...overrides,
  };
}
