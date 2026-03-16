import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";

type NavItem = "capabilities" | "exchanges" | "errors" | "events";
type DrillView = "none" | "exchange-list" | "exchange-detail";

type NavSection = {
  label?: string;
  items: { key: NavItem; label: string; shortcut: string }[];
};

const NAV_SECTIONS: NavSection[] = [
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

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

interface RouteSummary {
  id: string;
  status: string;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
  droppedExchanges: number;
  avgDurationMs: number | null;
}

interface ExchangeRecord {
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

interface EventRecord {
  id?: number;
  timestamp: string;
  contextId: string;
  eventName: string;
  details: string;
}

interface Metrics {
  totalRoutes: number;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
  droppedExchanges: number;
  errorRate: number;
  avgDurationMs: number | null;
}

// -- Utilities --

function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "started":
      return "green";
    case "failed":
      return "red";
    case "stopped":
    case "dropped":
      return "yellow";
    default:
      return "white";
  }
}

function col(str: string, len: number): string {
  if (len <= 0) return "";
  if (str.length > len) return str.slice(0, len - 1) + "\u2026";
  return str.padEnd(len);
}

function formatDetails(_eventName: string, raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;

    // Step/operation events: show operation + adapter + duration
    if ("operation" in d && "routeId" in d) {
      const parts: string[] = [String(d["operation"])];
      if ("adapter" in d) parts.push(`(${d["adapter"]})`);
      if ("adapterId" in d) parts.push(`(${d["adapterId"]})`);
      if ("duration" in d) parts.push(formatDuration(d["duration"] as number));
      if (
        "metadata" in d &&
        typeof d["metadata"] === "object" &&
        d["metadata"] !== null
      ) {
        const meta = d["metadata"] as Record<string, unknown>;
        const keys = Object.keys(meta).slice(0, 2);
        if (keys.length > 0) {
          parts.push(keys.map((k) => `${k}=${meta[k]}`).join(" "));
        }
      }
      return parts.join(" ");
    }

    // Exchange events: show route + exchange ID + duration/error
    if ("routeId" in d && "exchangeId" in d) {
      const exId = String(d["exchangeId"]).slice(0, 8);
      const dur =
        "duration" in d ? ` ${formatDuration(d["duration"] as number)}` : "";
      const err = "error" in d ? " ERROR" : "";
      return `${d["routeId"]} ex=${exId}${dur}${err}`;
    }

    // Route lifecycle events
    if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
      const route = d["route"] as {
        routeId?: string;
        definition?: { id?: string };
      };
      return `${route.routeId ?? route.definition?.id ?? "?"}`;
    }

    if ("pluginId" in d) return `plugin=${d["pluginId"]}`;
    if ("error" in d) {
      const err = d["error"];
      if (typeof err === "object" && err !== null && "message" in err)
        return String((err as { message: string }).message);
      return String(err);
    }
    return raw.length > 100 ? raw.slice(0, 97) + "..." : raw;
  } catch {
    return raw;
  }
}

/**
 * Render a multi-row bar chart from bucket values.
 * Each column is one bucket; rows build from bottom to top.
 * Returns an array of strings, one per row (top row first).
 */
function barChart(
  values: number[],
  maxWidth: number,
  chartHeight: number,
): string[] {
  if (values.length === 0) {
    return Array.from({ length: chartHeight }, () => " ".repeat(maxWidth));
  }
  const data = values.slice(0, maxWidth);
  const max = Math.max(...data, 1);

  const rows: string[] = [];
  for (let row = chartHeight - 1; row >= 0; row--) {
    const threshold = (row / chartHeight) * max;
    let line = "";
    for (const v of data) {
      if (v > threshold) {
        // How full is this cell? Map to block character
        const cellFill = Math.min((v - threshold) / (max / chartHeight), 1);
        const blocks = [
          " ",
          "\u2581",
          "\u2582",
          "\u2583",
          "\u2584",
          "\u2585",
          "\u2586",
          "\u2587",
          "\u2588",
        ];
        line += blocks[Math.round(cellFill * 8)];
      } else {
        line += " ";
      }
    }
    rows.push(line.padEnd(maxWidth));
  }
  return rows;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Compute scroll offset so the selected item stays visible within `visibleRows`.
 * Returns the start index of the visible window.
 */
function scrollOffset(
  selectedIndex: number,
  totalItems: number,
  visibleRows: number,
): number {
  if (totalItems <= visibleRows) return 0;
  // Keep selected item roughly centered, clamped to bounds
  const half = Math.floor(visibleRows / 2);
  const offset = Math.max(0, selectedIndex - half);
  return Math.min(offset, totalItems - visibleRows);
}

// -- Center panel: Overview --

function CenterOverview({
  route,
  recentExchanges,
  centerWidth,
  bodyHeight,
}: {
  route: RouteSummary | undefined;
  recentExchanges: ExchangeRecord[];
  centerWidth: number;
  bodyHeight: number;
}) {
  const recentRows = Math.max(bodyHeight - 10, 3);
  const offset = scrollOffset(0, recentExchanges.length, recentRows);

  return (
    <Box flexDirection="column" width={centerWidth} flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        {route ? (
          <>
            <Text bold>
              CAPABILITY: <Text color="cyan">{route.id}</Text>
            </Text>
            <Text>
              Status:{" "}
              <Text color={statusColor(route.status)}>{route.status}</Text>
              {"    "}Exchanges:{" "}
              <Text bold>{fmtNum(route.totalExchanges)}</Text>
              {"    "}Errors:{" "}
              <Text
                bold
                {...(route.failedExchanges > 0
                  ? { color: "red" as const }
                  : {})}
              >
                {fmtNum(route.failedExchanges)}
              </Text>
              {"    "}Dropped:{" "}
              <Text
                bold
                {...(route.droppedExchanges > 0
                  ? { color: "yellow" as const }
                  : {})}
              >
                {fmtNum(route.droppedExchanges)}
              </Text>
              {"    "}Avg:{" "}
              <Text bold>{formatDuration(route.avgDurationMs)}</Text>
            </Text>
          </>
        ) : (
          <Text dimColor>Select a capability to view details</Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexGrow={1}
      >
        <Text bold dimColor>
          RECENT EXCHANGES
        </Text>
        <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
        {(() => {
          // Fixed columns: status(9) + duration(7) + time(8) + gaps(8) = 32
          const idColWidth = Math.max(centerWidth - 36, 12);
          return recentExchanges.length === 0 ? (
            <Text dimColor>No exchanges yet</Text>
          ) : (
            recentExchanges.slice(offset, offset + recentRows).map((ex) => (
              <Text key={ex.id + ex.contextId} wrap="truncate">
                <Text dimColor>{col(ex.id, idColWidth)}</Text>
                {"  "}
                <Text color={statusColor(ex.status)}>{col(ex.status, 9)}</Text>
                {"  "}
                <Text>{formatDuration(ex.durationMs).padStart(7)}</Text>
                {"  "}
                <Text dimColor>
                  {ex.startedAt.replace("T", " ").slice(11, 19)}
                </Text>
              </Text>
            ))
          );
        })()}
        {recentExchanges.length > recentRows && (
          <Text dimColor>
            {"\u2191"} {recentExchanges.length - recentRows} more
          </Text>
        )}
      </Box>
    </Box>
  );
}

// -- Center panel: Exchange list --

function CenterExchangeList({
  capabilityId,
  exchanges,
  selectedIndex,
  centerWidth,
  bodyHeight,
}: {
  capabilityId: string;
  exchanges: ExchangeRecord[];
  selectedIndex: number;
  centerWidth: number;
  bodyHeight: number;
}) {
  const idColWidth = Math.max(centerWidth - 50, 8);
  const tableRows = Math.max(bodyHeight - 6, 3);
  const offset = scrollOffset(selectedIndex, exchanges.length, tableRows);

  return (
    <Box
      flexDirection="column"
      width={centerWidth}
      flexGrow={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>
        EXCHANGES: <Text color="cyan">{capabilityId}</Text>
      </Text>
      <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
      <Text bold dimColor>
        {"  "}
        {col("ID", idColWidth)}
        {"  "}
        {col("Status", 9)}
        {"  "}
        {"Duration".padStart(8)}
        {"  "}
        {"Time"}
      </Text>
      {exchanges.length === 0 ? (
        <Text dimColor>No exchanges</Text>
      ) : (
        exchanges.slice(offset, offset + tableRows).map((ex, vi) => {
          const i = offset + vi;
          return (
            <Text key={ex.id + ex.contextId} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {col(truncate(ex.id, idColWidth), idColWidth)}
              </Text>
              {"  "}
              <Text color={statusColor(ex.status)}>{col(ex.status, 9)}</Text>
              {"  "}
              <Text>{formatDuration(ex.durationMs).padStart(8)}</Text>
              {"  "}
              <Text dimColor>
                {ex.startedAt.replace("T", " ").slice(11, 19)}
              </Text>
            </Text>
          );
        })
      )}
      {exchanges.length > tableRows && (
        <Text dimColor>
          {offset + tableRows < exchanges.length ? "\u2193 " : "  "}
          {exchanges.length} total
        </Text>
      )}
    </Box>
  );
}

// -- Center panel: Exchange detail --

/**
 * Parse event details JSON safely, returning null on failure.
 */
function parseDetails(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Group events by exchangeId to show parent/child flow.
 *
 * Operation events (split/aggregate) use their own exchangeId but
 * logically belong to the parent pipeline. Step events with a
 * different exchangeId are actual children.
 */
function groupEventsByExchange(
  events: EventRecord[],
  parentExchangeId: string,
): { exchangeId: string; label: string; events: EventRecord[] }[] {
  const groups = new Map<
    string,
    { exchangeId: string; label: string; events: EventRecord[] }
  >();
  let childIndex = 0;

  // Ensure parent group exists first
  groups.set(parentExchangeId, {
    exchangeId: parentExchangeId,
    label: "parent",
    events: [],
  });

  for (const ev of events) {
    const d = parseDetails(ev.details);
    const exId = d ? String(d["exchangeId"] ?? "") : "";
    const key = !exId || exId === parentExchangeId ? parentExchangeId : exId;

    if (!groups.has(key)) {
      childIndex++;
      groups.set(key, {
        exchangeId: key,
        label: `child ${childIndex}`,
        events: [],
      });
    }
    groups.get(key)!.events.push(ev);
  }

  return Array.from(groups.values());
}

function CenterExchangeDetail({
  exchange,
  events,
  centerWidth,
  bodyHeight,
  scrollIndex,
}: {
  exchange: ExchangeRecord;
  events: EventRecord[];
  centerWidth: number;
  bodyHeight: number;
  scrollIndex: number;
}) {
  const eventColWidth = Math.min(Math.max(centerWidth - 30, 15), 40);
  const detailsColWidth = Math.max(centerWidth - eventColWidth - 28, 5);
  const eventRows = Math.max(bodyHeight - 8, 3);

  const groups = groupEventsByExchange(events, exchange.id);
  const hasChildren = groups.length > 1;

  // Flatten groups into displayable rows with headers
  const displayRows: {
    type: "header" | "event";
    text?: string;
    event?: EventRecord;
    indent: number;
  }[] = [];
  for (const group of groups) {
    if (hasChildren) {
      displayRows.push({
        type: "header",
        text: `${group.label} (${group.exchangeId.slice(0, 8)}) - ${group.events.length} events`,
        indent: 0,
      });
    }
    for (const ev of group.events) {
      displayRows.push({
        type: "event",
        event: ev,
        indent: hasChildren ? 2 : 0,
      });
    }
  }

  return (
    <Box flexDirection="column" width={centerWidth} flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        <Text bold>
          EXCHANGE:{" "}
          <Text color="cyan">{truncate(exchange.id, centerWidth - 14)}</Text>
        </Text>
        <Text>
          Capability: <Text bold>{exchange.routeId}</Text>
          {"    "}Status:{" "}
          <Text color={statusColor(exchange.status)}>{exchange.status}</Text>
          {exchange.durationMs !== null && (
            <Text>
              {"    "}Duration:{" "}
              <Text bold>{formatDuration(exchange.durationMs)}</Text>
            </Text>
          )}
        </Text>
        <Text dimColor>
          Started: {exchange.startedAt}
          {exchange.completedAt && `    Completed: ${exchange.completedAt}`}
        </Text>
        {exchange.error && <Text color="red">Error: {exchange.error}</Text>}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexGrow={1}
      >
        <Text bold dimColor>
          {hasChildren
            ? `EXCHANGE FLOW (${groups.length} exchanges, ${events.length} events)`
            : `RELATED EVENTS (${events.length})`}
        </Text>
        <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
        {displayRows.length === 0 ? (
          <Text dimColor>No related events found</Text>
        ) : (
          displayRows
            .slice(scrollIndex, scrollIndex + eventRows)
            .map((row, i) => {
              if (row.type === "header") {
                return (
                  <Text key={`h-${i}`} bold color="yellow">
                    {row.text}
                  </Text>
                );
              }
              const ev = row.event!;
              const indent = " ".repeat(row.indent);
              return (
                <Text key={ev.id ?? `${ev.timestamp}-${i}`} wrap="truncate">
                  <Text dimColor>
                    {indent}
                    {ev.timestamp.replace("T", " ").slice(11, 19)}
                  </Text>
                  {"  "}
                  <Text color="cyan">{col(ev.eventName, eventColWidth)}</Text>
                  {"  "}
                  <Text>
                    {truncate(
                      formatDetails(ev.eventName, ev.details),
                      detailsColWidth,
                    )}
                  </Text>
                </Text>
              );
            })
        )}
        {displayRows.length > scrollIndex + eventRows && (
          <Text dimColor>
            {"\u2193"} {displayRows.length - scrollIndex - eventRows} more
          </Text>
        )}
      </Box>
    </Box>
  );
}

// -- Events panel (inline, no help bar) --

function EventsView({
  events,
  selectedIndex,
  width,
  height,
}: {
  events: EventRecord[];
  selectedIndex: number;
  width: number;
  height: number;
}) {
  const eventColWidth = Math.min(Math.max(Math.floor(width * 0.3), 20), 45);
  const detailsColWidth = Math.max(width - eventColWidth - 28, 10);
  const tableRows = Math.max(height - 6, 5);
  const offset = scrollOffset(selectedIndex, events.length, tableRows);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>
        EVENTS <Text dimColor>({events.length} total)</Text>
      </Text>
      <Text dimColor>{"\u2500".repeat(Math.max(width - 4, 20))}</Text>
      <Text bold dimColor>
        {"  "}
        {col("Timestamp", 19)}
        {"  "}
        {col("Event", eventColWidth)}
        {"  "}Details
      </Text>
      {events.length === 0 ? (
        <Text dimColor>No events recorded yet.</Text>
      ) : (
        events.slice(offset, offset + tableRows).map((ev, vi) => {
          const i = offset + vi;
          return (
            <Text key={ev.id ?? ev.timestamp} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {ev.timestamp.replace("T", " ").slice(0, 19)}
              </Text>
              {"  "}
              <Text color="cyan">{col(ev.eventName, eventColWidth)}</Text>
              {"  "}
              <Text>
                {truncate(
                  formatDetails(ev.eventName, ev.details),
                  detailsColWidth,
                )}
              </Text>
            </Text>
          );
        })
      )}
      {events.length > tableRows && (
        <Text dimColor>
          {offset + tableRows < events.length ? "\u2193 " : "  "}
          {events.length} total
        </Text>
      )}
    </Box>
  );
}

// -- Capability list (left nav sub-panel) --

function CapabilityList({
  routes,
  selectedIndex,
  visibleRows,
  colWidth,
}: {
  routes: RouteSummary[];
  selectedIndex: number;
  visibleRows: number;
  colWidth: number;
}) {
  const offset = scrollOffset(selectedIndex, routes.length, visibleRows);

  return (
    <>
      <Text> </Text>
      <Text bold dimColor>
        {"\u2500".repeat(colWidth + 2)}
      </Text>
      {routes.length === 0 ? (
        <Text dimColor>No capabilities</Text>
      ) : (
        routes.slice(offset, offset + visibleRows).map((route, vi) => {
          const i = offset + vi;
          return (
            <Text key={route.id} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {truncate(route.id, colWidth)}
              </Text>
            </Text>
          );
        })
      )}
      {routes.length > visibleRows && (
        <Text dimColor>
          {selectedIndex + 1}/{routes.length}
        </Text>
      )}
    </>
  );
}

// -- Main App --

function App({ db }: { db: TelemetryDb }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [activeNav, setActiveNav] = useState<NavItem>("capabilities");
  const [drillView, setDrillView] = useState<DrillView>("none");

  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({
    totalRoutes: 0,
    totalExchanges: 0,
    completedExchanges: 0,
    failedExchanges: 0,
    droppedExchanges: 0,
    errorRate: 0,
    avgDurationMs: null,
  });
  const [traffic, setTraffic] = useState<number[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [recentExchanges, setRecentExchanges] = useState<ExchangeRecord[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeRecord[]>([]);
  const [selectedExchangeIndex, setSelectedExchangeIndex] = useState(0);
  const [selectedExchange, setSelectedExchange] = useState<
    ExchangeRecord | undefined
  >(undefined);
  const [exchangeEvents, setExchangeEvents] = useState<EventRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [detailScrollIndex, setDetailScrollIndex] = useState(0);

  const refresh = useCallback(() => {
    try {
      const routeSummary = db.getRouteSummary();
      setRoutes(routeSummary);
      setMetrics(db.getMetrics());
      setTraffic(db.getTrafficBuckets());

      if (activeNav === "capabilities") {
        const route = routeSummary[selectedRouteIndex];
        if (route) {
          if (drillView === "none") {
            setRecentExchanges(db.getExchangesByRoute(route.id, 50));
          } else if (drillView === "exchange-list") {
            setExchanges(db.getExchangesByRoute(route.id));
          }
        }
      }

      if (activeNav === "exchanges") {
        setExchanges(db.getAllExchanges(200));
      }

      if (activeNav === "errors") {
        setExchanges(db.getFailedExchanges(200));
      }

      if (activeNav === "events") {
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    } catch {
      // Database may be temporarily locked
    }
  }, [db, activeNav, drillView, selectedRouteIndex]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  const selectRoute = useCallback(
    (index: number) => {
      setSelectedRouteIndex(index);
      const route = routes[index];
      if (route) {
        setRecentExchanges(db.getExchangesByRoute(route.id, 50));
      }
    },
    [db, routes],
  );

  const switchNav = useCallback(
    (nav: NavItem) => {
      setActiveNav(nav);
      setDrillView("none");
      if (nav === "events") {
        setSelectedEventIndex(0);
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    },
    [db],
  );

  useInput((input, key) => {
    if (input === "q") {
      db.close();
      exit();
      return;
    }

    // Number shortcuts to switch nav (always available)
    const navByShortcut = ALL_NAV_ITEMS.find((n) => n.shortcut === input);
    if (navByShortcut) {
      switchNav(navByShortcut.key);
      return;
    }

    if (activeNav === "events") {
      if (input === "j" || key.downArrow) {
        setSelectedEventIndex((i) => Math.min(i + 1, events.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedEventIndex((i) => Math.max(i - 1, 0));
      }
      return;
    }

    if (
      (activeNav === "exchanges" || activeNav === "errors") &&
      drillView === "none"
    ) {
      if (input === "j" || key.downArrow) {
        setSelectedExchangeIndex((i) => Math.min(i + 1, exchanges.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedExchangeIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const ex = exchanges[selectedExchangeIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id, ex.correlationId));
          setDrillView("exchange-detail");
        }
      }
      return;
    }

    if (activeNav === "capabilities" && drillView === "none") {
      if (input === "j" || key.downArrow) {
        selectRoute(Math.min(selectedRouteIndex + 1, routes.length - 1));
      } else if (input === "k" || key.upArrow) {
        selectRoute(Math.max(selectedRouteIndex - 1, 0));
      } else if (key.return) {
        const route = routes[selectedRouteIndex];
        if (route) {
          setSelectedExchangeIndex(0);
          setExchanges(db.getExchangesByRoute(route.id));
          setDrillView("exchange-list");
        }
      }
    } else if (drillView === "exchange-list") {
      if (input === "j" || key.downArrow) {
        setSelectedExchangeIndex((i) => Math.min(i + 1, exchanges.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedExchangeIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const ex = exchanges[selectedExchangeIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id, ex.correlationId));
          setDrillView("exchange-detail");
        }
      } else if (key.escape || key.backspace || key.delete) {
        setDrillView("none");
      }
    } else if (drillView === "exchange-detail") {
      if (input === "j" || key.downArrow) {
        setDetailScrollIndex((i) => i + 1);
      } else if (input === "k" || key.upArrow) {
        setDetailScrollIndex((i) => Math.max(i - 1, 0));
      } else if (key.escape || key.backspace || key.delete) {
        setDetailScrollIndex(0);
        setDrillView(
          activeNav === "exchanges" || activeNav === "errors"
            ? "none"
            : "exchange-list",
        );
      }
    }
  });

  // Layout dimensions
  const leftWidth = Math.max(Math.min(Math.floor(width * 0.18), 26), 16);
  const rightWidth = Math.max(Math.min(Math.floor(width * 0.22), 30), 20);
  const centerWidth = Math.max(width - leftWidth - rightWidth, 30);
  const bodyHeight = Math.max(height - 5, 10);
  // Keymap box: border (2) + title (1) + items (dynamic, estimate max 6)
  const keymapHeight = 9;
  // Nav header: border (2) + title (1) + separator (1) + nav items (4) + spacer (1) + separator (1)
  const navHeaderRows = 10;
  const navListHeight = Math.max(bodyHeight - keymapHeight - navHeaderRows, 3);
  const selectedRoute = routes[selectedRouteIndex];

  // Keymap items based on context
  const keymapItems: { key: string; action: string }[] = [];
  keymapItems.push({ key: "j/k", action: "Navigate" });
  if (activeNav === "capabilities" && drillView === "none") {
    keymapItems.push({ key: "Enter", action: "Drill-down" });
  }
  if (drillView === "exchange-list") {
    keymapItems.push({ key: "Enter", action: "Detail" });
    keymapItems.push({ key: "Esc", action: "Back" });
  }
  if (drillView === "exchange-detail") {
    keymapItems.push({ key: "Esc", action: "Back" });
  }
  keymapItems.push({ key: "1/2/3", action: "Switch view" });
  keymapItems.push({ key: "q", action: "Quit" });

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Title bar */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          ROUTECRAFT TUI
        </Text>
        <Text> </Text>
        <Text dimColor>v0.4.0</Text>
      </Box>

      {/* 3-column body */}
      <Box flexDirection="row" width={width} flexGrow={1}>
        {/* Left column: Navigation (top) + Keymap (bottom) */}
        <Box flexDirection="column" width={leftWidth}>
          {/* Navigation */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            flexGrow={1}
          >
            <Text bold color="cyan">
              NAVIGATION
            </Text>
            <Text dimColor>{"\u2500".repeat(leftWidth - 4)}</Text>
            {NAV_SECTIONS.map((section, si) => (
              <Box key={section.label ?? si} flexDirection="column">
                {si > 0 && <Text> </Text>}
                {section.label && (
                  <Text dimColor bold>
                    {section.label}
                  </Text>
                )}
                {section.items.map((item) => (
                  <Text key={item.key}>
                    <Text
                      bold={activeNav === item.key}
                      {...(activeNav === item.key
                        ? { color: "cyan" as const }
                        : {})}
                    >
                      {activeNav === item.key ? "> " : "  "}
                      {item.label}
                    </Text>
                    <Text dimColor> ({item.shortcut})</Text>
                  </Text>
                ))}
              </Box>
            ))}

            {/* Inline list for capabilities nav */}
            {activeNav === "capabilities" && (
              <CapabilityList
                routes={routes}
                selectedIndex={selectedRouteIndex}
                visibleRows={navListHeight}
                colWidth={leftWidth - 6}
              />
            )}
          </Box>

          {/* Keymap */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            <Text bold color="cyan">
              KEYMAP
            </Text>
            {keymapItems.map((item) => (
              <Text key={item.key}>
                <Text color="yellow">[{item.key}]</Text>
                {"  "}
                <Text>{item.action}</Text>
              </Text>
            ))}
          </Box>
        </Box>

        {/* Center */}
        {activeNav === "capabilities" && drillView === "none" && (
          <CenterOverview
            route={selectedRoute}
            recentExchanges={recentExchanges}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {activeNav === "capabilities" && drillView === "exchange-list" && (
          <CenterExchangeList
            capabilityId={selectedRoute?.id ?? ""}
            exchanges={exchanges}
            selectedIndex={selectedExchangeIndex}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {activeNav === "capabilities" &&
          drillView === "exchange-detail" &&
          selectedExchange && (
            <CenterExchangeDetail
              exchange={selectedExchange}
              events={exchangeEvents}
              centerWidth={centerWidth}
              bodyHeight={bodyHeight}
              scrollIndex={detailScrollIndex}
            />
          )}
        {activeNav === "exchanges" && drillView === "none" && (
          <CenterExchangeList
            capabilityId="All Capabilities"
            exchanges={exchanges}
            selectedIndex={selectedExchangeIndex}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {activeNav === "exchanges" &&
          drillView === "exchange-detail" &&
          selectedExchange && (
            <CenterExchangeDetail
              exchange={selectedExchange}
              events={exchangeEvents}
              centerWidth={centerWidth}
              bodyHeight={bodyHeight}
              scrollIndex={detailScrollIndex}
            />
          )}
        {activeNav === "errors" && drillView === "none" && (
          <CenterExchangeList
            capabilityId="Failed Exchanges"
            exchanges={exchanges}
            selectedIndex={selectedExchangeIndex}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {activeNav === "errors" &&
          drillView === "exchange-detail" &&
          selectedExchange && (
            <CenterExchangeDetail
              exchange={selectedExchange}
              events={exchangeEvents}
              centerWidth={centerWidth}
              bodyHeight={bodyHeight}
              scrollIndex={detailScrollIndex}
            />
          )}
        {activeNav === "events" && (
          <EventsView
            events={events}
            selectedIndex={selectedEventIndex}
            width={centerWidth}
            height={bodyHeight}
          />
        )}

        {/* Right: Metrics + sparkline */}
        <Box
          flexDirection="column"
          width={rightWidth}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold color="cyan">
            METRICS
          </Text>
          <Text dimColor>{"\u2500".repeat(rightWidth - 4)}</Text>

          {barChart(traffic, rightWidth - 4, 5).map((row, i) => (
            <Text key={i} color="green">
              {row}
            </Text>
          ))}
          <Text dimColor>Traffic (last hour)</Text>

          <Text>
            {"Exchanges:".padEnd(14)}
            <Text bold color="cyan">
              {fmtNum(metrics.totalExchanges).padStart(rightWidth - 18)}
            </Text>
          </Text>
          <Text>
            {"Completed:".padEnd(14)}
            <Text bold color="green">
              {fmtNum(metrics.completedExchanges).padStart(rightWidth - 18)}
            </Text>
          </Text>
          <Text>
            {"Errors:".padEnd(14)}
            <Text bold color={metrics.failedExchanges > 0 ? "red" : "green"}>
              {fmtNum(metrics.failedExchanges).padStart(rightWidth - 18)}
            </Text>
          </Text>
          <Text>
            {"Dropped:".padEnd(14)}
            <Text
              bold
              color={metrics.droppedExchanges > 0 ? "yellow" : "green"}
            >
              {fmtNum(metrics.droppedExchanges).padStart(rightWidth - 18)}
            </Text>
          </Text>
          <Text>
            {"Error Rate:".padEnd(14)}
            <Text bold color={metrics.errorRate > 0.1 ? "red" : "green"}>
              {`${(metrics.errorRate * 100).toFixed(1)}%`.padStart(
                rightWidth - 18,
              )}
            </Text>
          </Text>
          <Text>
            {"Avg Duration:".padEnd(14)}
            <Text bold>
              {formatDuration(metrics.avgDurationMs).padStart(rightWidth - 18)}
            </Text>
          </Text>
          <Text>
            {"Capabilities:".padEnd(14)}
            <Text bold>
              {fmtNum(metrics.totalRoutes).padStart(rightWidth - 18)}
            </Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function renderTui(dbPath: string): Promise<void> {
  let db: TelemetryDb;
  try {
    db = await TelemetryDb.open(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to open telemetry database: ${msg}\n`);
    process.stderr.write(`Path: ${dbPath}\n`);
    process.stderr.write(
      "Make sure you have a running Routecraft context with telemetry() enabled.\n",
    );
    process.exit(1);
  }

  const instance = render(<App db={db} />);
  await instance.waitUntilExit();
}
