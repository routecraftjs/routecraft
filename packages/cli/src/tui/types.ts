export type NavItem = "capabilities" | "exchanges" | "errors" | "events";

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
      { key: "exchanges", label: "Exchanges", shortcut: "2" },
      { key: "errors", label: "Errors", shortcut: "3" },
      { key: "events", label: "Events", shortcut: "4" },
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
