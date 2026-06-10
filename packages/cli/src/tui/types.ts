export type NavItem =
  | "capabilities"
  | "agents"
  | "tools"
  | "exchanges"
  | "errors"
  | "events";

export type NavSection = {
  label?: string;
  items: { key: NavItem; label: string; shortcut: string }[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ key: "capabilities", label: "Capabilities", shortcut: "1" }],
  },
  {
    items: [
      { key: "agents", label: "Agents", shortcut: "2" },
      { key: "tools", label: "Tools", shortcut: "3" },
    ],
  },
  {
    items: [
      { key: "exchanges", label: "Exchanges", shortcut: "4" },
      { key: "errors", label: "Errors", shortcut: "5" },
      { key: "events", label: "Events", shortcut: "6" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

export interface RouteSummary {
  id: string;
  status: string;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
  droppedExchanges: number;
  avgDurationMs: number | null;
}

export interface ExchangeRecord {
  id: string;
  routeId: string;
  contextId: string;
  correlationId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface EventRecord {
  id?: number;
  timestamp: string;
  contextId: string;
  eventName: string;
  details: string;
}

export interface Metrics {
  totalRoutes: number;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
  droppedExchanges: number;
  errorRate: number;
  avgDurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
}

export interface ExchangeSnapshot {
  headers: string;
  body: string | null;
  truncated: boolean;
}

export interface RouteActivity {
  throughput: number[];
  recentErrors: number;
}

/**
 * A summary row for the Agents tab. `key` is the registered agent id for
 * by-name agents, or the dispatching route id for inline agents.
 */
export interface AgentSummary {
  key: string;
  source: "registered" | "inline";
  model: string | null;
  description: string | null;
  runCount: number;
  errorCount: number;
  totalTokens: number;
  lastRunAt: string | null;
}

/** A summary row for the Tools tab. */
export interface ToolSummary {
  name: string;
  source: "registered" | "observed";
  callCount: number;
  errorCount: number;
  lastCalledAt: string | null;
}

/** Per-run agent detail, keyed by the dispatching exchange. */
export interface AgentRunInfo {
  exchangeId: string;
  model: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  status: "running" | "finished" | "error";
}

/**
 * A single tool invocation, correlating the invoked/result/error events
 * for one `toolCallId`. `input`/`output`/`error` are only populated when
 * telemetry snapshot capture was enabled; `errorName` is the always
 * persisted, non-sensitive error class.
 */
export interface ToolCallRow {
  toolCallId: string;
  toolName: string;
  routeId: string;
  exchangeId: string;
  agentName: string | null;
  status: "invoked" | "result" | "error";
  durationMs: number | null;
  timestamp: string;
  hasInput: boolean;
  hasOutput: boolean;
  input: string | null;
  output: string | null;
  error: string | null;
  errorName: string | null;
}
