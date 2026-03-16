import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";

type CenterView = "overview" | "exchanges" | "exchange-detail";
type TopView = "dashboard" | "events";

interface RouteSummary {
  id: string;
  status: string;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
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
    if ("routeId" in d && "exchangeId" in d) {
      const exId = String(d["exchangeId"]).slice(0, 8);
      const dur =
        "duration" in d ? ` ${formatDuration(d["duration"] as number)}` : "";
      const err = "error" in d ? " ERROR" : "";
      return `${d["routeId"]} ex=${exId}${dur}${err}`;
    }
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

function sparkline(values: number[], maxWidth: number): string {
  if (values.length === 0) return "";
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
  const data = values.slice(0, maxWidth);
  const max = Math.max(...data, 1);
  return data.map((v) => blocks[Math.round((v / max) * 8)]!).join("");
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
        {recentExchanges.length === 0 ? (
          <Text dimColor>No exchanges yet</Text>
        ) : (
          recentExchanges.slice(offset, offset + recentRows).map((ex) => (
            <Text key={ex.id + ex.contextId} wrap="truncate">
              <Text dimColor>{truncate(ex.id, 8)}</Text>
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
        )}
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

function CenterExchangeDetail({
  exchange,
  events,
  centerWidth,
  bodyHeight,
}: {
  exchange: ExchangeRecord;
  events: EventRecord[];
  centerWidth: number;
  bodyHeight: number;
}) {
  const eventColWidth = Math.min(Math.max(centerWidth - 30, 15), 40);
  const detailsColWidth = Math.max(centerWidth - eventColWidth - 28, 5);
  const eventRows = Math.max(bodyHeight - 14, 3);

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
          RELATED EVENTS ({events.length})
        </Text>
        <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
        {events.length === 0 ? (
          <Text dimColor>No related events found</Text>
        ) : (
          events.slice(0, eventRows).map((ev) => (
            <Text key={ev.id ?? ev.timestamp} wrap="truncate">
              <Text dimColor>
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
          ))
        )}
        {events.length > eventRows && (
          <Text dimColor>
            {"\u2193"} {events.length - eventRows} more
          </Text>
        )}
      </Box>
    </Box>
  );
}

// -- Full-screen Events view --

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
  const tableRows = Math.max(height - 9, 5);
  const offset = scrollOffset(selectedIndex, events.length, tableRows);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          Events
        </Text>
        <Text dimColor> ({events.length} total)</Text>
      </Box>

      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={width}
        flexGrow={1}
      >
        <Text bold dimColor>
          {"  "}
          {col("Timestamp", 19)}
          {"  "}
          {col("Event", eventColWidth)}
          {"  "}Details
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(Math.max(width - 6, 50))}</Text>
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
      </Box>

      <Box gap={2} paddingX={1}>
        <Text dimColor>j/k: Navigate</Text>
        <Text dimColor>Esc: Back</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Main App --

function App({ db }: { db: TelemetryDb }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [topView, setTopView] = useState<TopView>("dashboard");
  const [centerView, setCenterView] = useState<CenterView>("overview");

  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({
    totalRoutes: 0,
    totalExchanges: 0,
    completedExchanges: 0,
    failedExchanges: 0,
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

  const refresh = useCallback(() => {
    try {
      const routeSummary = db.getRouteSummary();
      setRoutes(routeSummary);
      setMetrics(db.getMetrics());
      setTraffic(db.getTrafficBuckets(30));

      if (topView === "dashboard") {
        const route = routeSummary[selectedRouteIndex];
        if (route) {
          if (centerView === "overview") {
            setRecentExchanges(db.getExchangesByRoute(route.id, 50));
          } else if (centerView === "exchanges") {
            setExchanges(db.getExchangesByRoute(route.id));
          }
        }
      }

      if (topView === "events") {
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    } catch {
      // Database may be temporarily locked
    }
  }, [db, topView, centerView, selectedRouteIndex]);

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

  useInput((input, key) => {
    if (input === "q") {
      db.close();
      exit();
      return;
    }

    if (topView === "events") {
      if (input === "j" || key.downArrow) {
        setSelectedEventIndex((i) => Math.min(i + 1, events.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedEventIndex((i) => Math.max(i - 1, 0));
      } else if (key.escape || key.backspace || key.delete) {
        setTopView("dashboard");
      }
      return;
    }

    if (centerView === "overview") {
      if (input === "j" || key.downArrow) {
        selectRoute(Math.min(selectedRouteIndex + 1, routes.length - 1));
      } else if (input === "k" || key.upArrow) {
        selectRoute(Math.max(selectedRouteIndex - 1, 0));
      } else if (key.return) {
        const route = routes[selectedRouteIndex];
        if (route) {
          setSelectedExchangeIndex(0);
          setExchanges(db.getExchangesByRoute(route.id));
          setCenterView("exchanges");
        }
      } else if (input === "e") {
        setSelectedEventIndex(0);
        setEvents(db.getRecentEvents({ limit: 200 }));
        setTopView("events");
      }
    } else if (centerView === "exchanges") {
      if (input === "j" || key.downArrow) {
        setSelectedExchangeIndex((i) => Math.min(i + 1, exchanges.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedExchangeIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const ex = exchanges[selectedExchangeIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id));
          setCenterView("exchange-detail");
        }
      } else if (key.escape || key.backspace || key.delete) {
        setCenterView("overview");
      }
    } else if (centerView === "exchange-detail") {
      if (key.escape || key.backspace || key.delete) {
        setCenterView("exchanges");
      }
    }
  });

  // Full-screen events view
  if (topView === "events") {
    return (
      <EventsView
        events={events}
        selectedIndex={selectedEventIndex}
        width={width}
        height={height}
      />
    );
  }

  // 3-column dashboard
  const leftWidth = Math.max(Math.min(Math.floor(width * 0.18), 26), 16);
  const rightWidth = Math.max(Math.min(Math.floor(width * 0.22), 30), 20);
  const centerWidth = Math.max(width - leftWidth - rightWidth, 30);
  const bodyHeight = Math.max(height - 5, 10);
  const routeListRows = Math.max(bodyHeight - 4, 3);
  const routeOffset = scrollOffset(
    selectedRouteIndex,
    routes.length,
    routeListRows,
  );
  const selectedRoute = routes[selectedRouteIndex];

  const helpItems =
    centerView === "overview"
      ? ["j/k: Navigate", "Enter: Exchanges", "e: Events", "q: Quit"]
      : centerView === "exchanges"
        ? ["j/k: Navigate", "Enter: Detail", "Esc: Back", "q: Quit"]
        : ["Esc: Back", "q: Quit"];

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
        {/* Left: Capabilities list */}
        <Box
          flexDirection="column"
          width={leftWidth}
          borderStyle="round"
          borderColor={centerView === "overview" ? "cyan" : "gray"}
          paddingX={1}
        >
          <Text bold color="cyan">
            CAPABILITIES
          </Text>
          <Text dimColor>{"\u2500".repeat(leftWidth - 4)}</Text>
          {routes.length === 0 ? (
            <Text dimColor>None</Text>
          ) : (
            routes
              .slice(routeOffset, routeOffset + routeListRows)
              .map((route, vi) => {
                const i = routeOffset + vi;
                return (
                  <Text key={route.id} wrap="truncate">
                    <Text
                      {...(i === selectedRouteIndex
                        ? { color: "cyan" as const }
                        : {})}
                      bold={i === selectedRouteIndex}
                    >
                      {i === selectedRouteIndex ? "> " : "  "}
                      {truncate(route.id, leftWidth - 6)}
                    </Text>
                  </Text>
                );
              })
          )}
          {routes.length > routeListRows && (
            <Text dimColor>{routes.length} total</Text>
          )}
        </Box>

        {/* Center */}
        {centerView === "overview" && (
          <CenterOverview
            route={selectedRoute}
            recentExchanges={recentExchanges}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {centerView === "exchanges" && (
          <CenterExchangeList
            capabilityId={selectedRoute?.id ?? ""}
            exchanges={exchanges}
            selectedIndex={selectedExchangeIndex}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
          />
        )}
        {centerView === "exchange-detail" && selectedExchange && (
          <CenterExchangeDetail
            exchange={selectedExchange}
            events={exchangeEvents}
            centerWidth={centerWidth}
            bodyHeight={bodyHeight}
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

          <Text color="green">{sparkline(traffic, rightWidth - 4)}</Text>
          <Text dimColor>Traffic (last 30m)</Text>
          <Text> </Text>

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

      {/* Help bar */}
      <Box gap={2} paddingX={1}>
        {helpItems.map((item) => (
          <Text key={item} dimColor>
            {item}
          </Text>
        ))}
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
