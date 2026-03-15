import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";

/**
 * View modes for the TUI application.
 */
type ViewMode = "dashboard" | "exchanges" | "exchange-detail" | "events";

/**
 * Route summary with aggregated metrics.
 */
interface RouteSummary {
  id: string;
  status: string;
  totalExchanges: number;
  completedExchanges: number;
  failedExchanges: number;
  avgDurationMs: number | null;
}

/**
 * Exchange record from the database.
 */
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

/**
 * Event record from the database.
 */
interface EventRecord {
  id?: number;
  timestamp: string;
  contextId: string;
  eventName: string;
  details: string;
}

// -- Utility functions --

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
      const err = "error" in d ? ` ERROR` : "";
      return `route=${d["routeId"]} ex=${exId}${dur}${err}`;
    }

    if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
      const route = d["route"] as {
        routeId?: string;
        definition?: { id?: string };
      };
      const id = route.routeId ?? route.definition?.id ?? "?";
      return `route=${id}`;
    }

    if ("pluginId" in d) {
      return `plugin=${d["pluginId"]}`;
    }

    if ("error" in d) {
      const err = d["error"];
      if (typeof err === "object" && err !== null && "message" in err) {
        return String((err as { message: string }).message);
      }
      return String(err);
    }

    return raw.length > 100 ? raw.slice(0, 97) + "..." : raw;
  } catch {
    return raw;
  }
}

// -- Dashboard View --

function DashboardView({
  routes,
  metrics,
  selectedIndex,
  width,
  height,
}: {
  routes: RouteSummary[];
  metrics: {
    totalRoutes: number;
    totalExchanges: number;
    completedExchanges: number;
    failedExchanges: number;
    errorRate: number;
    avgDurationMs: number | null;
  };
  selectedIndex: number;
  width: number;
  height: number;
}) {
  const idColWidth = Math.max(width - 62, 15);
  const tableRows = Math.max(height - 14, 5);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          Routecraft TUI - Dashboard
        </Text>
      </Box>

      <Box marginTop={1} gap={2} width={width}>
        <Box borderStyle="round" paddingX={1} flexGrow={1}>
          <Text>
            Routes:{" "}
            <Text bold color="cyan">
              {metrics.totalRoutes}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexGrow={1}>
          <Text>
            Exchanges:{" "}
            <Text bold color="cyan">
              {metrics.totalExchanges}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexGrow={1}>
          <Text>
            Errors:{" "}
            <Text bold color={metrics.failedExchanges > 0 ? "red" : "green"}>
              {metrics.failedExchanges}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexGrow={1}>
          <Text>
            Error Rate:{" "}
            <Text bold color={metrics.errorRate > 0.1 ? "red" : "green"}>
              {(metrics.errorRate * 100).toFixed(1)}%
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexGrow={1}>
          <Text>
            Avg Duration:{" "}
            <Text bold>{formatDuration(metrics.avgDurationMs)}</Text>
          </Text>
        </Box>
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
          {col("Route ID", idColWidth)}
          {"  "}
          {col("Status", 10)}
          {"  "}
          {"Total".padStart(6)}
          {"  "}
          {"OK".padStart(6)}
          {"  "}
          {"Fail".padStart(6)}
          {"  "}
          {"Avg Duration".padStart(12)}
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(Math.max(width - 6, 50))}</Text>
        {routes.length === 0 ? (
          <Text dimColor>
            No routes recorded yet. Start a context with telemetry() enabled.
          </Text>
        ) : (
          routes.slice(0, tableRows).map((route, i) => (
            <Text key={route.id}>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {col(route.id, idColWidth)}
              </Text>
              {"  "}
              <Text color={statusColor(route.status)}>
                {col(route.status, 10)}
              </Text>
              {"  "}
              <Text>{String(route.totalExchanges).padStart(6)}</Text>
              {"  "}
              <Text color="green">
                {String(route.completedExchanges).padStart(6)}
              </Text>
              {"  "}
              <Text
                {...(route.failedExchanges > 0
                  ? { color: "red" as const }
                  : {})}
              >
                {String(route.failedExchanges).padStart(6)}
              </Text>
              {"  "}
              <Text>{formatDuration(route.avgDurationMs).padStart(12)}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>j/k: Navigate</Text>
        <Text dimColor>Enter: Inspect exchanges</Text>
        <Text dimColor>e: Events</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Exchange List View --

function ExchangeListView({
  routeId,
  exchanges,
  selectedIndex,
  width,
  height,
}: {
  routeId: string;
  exchanges: ExchangeRecord[];
  selectedIndex: number;
  width: number;
  height: number;
}) {
  const idColWidth = Math.max(width - 66, 15);
  const tableRows = Math.max(height - 10, 5);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          Exchanges - {routeId}
        </Text>
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
          {col("Exchange ID", idColWidth)}
          {"  "}
          {col("Status", 10)}
          {"  "}
          {"Duration".padStart(10)}
          {"    "}
          {"Started At"}
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(Math.max(width - 6, 50))}</Text>
        {exchanges.length === 0 ? (
          <Text dimColor>No exchanges recorded for this route.</Text>
        ) : (
          exchanges.slice(0, tableRows).map((ex, i) => (
            <Text key={ex.id + ex.contextId}>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {col(ex.id, idColWidth)}
              </Text>
              {"  "}
              <Text color={statusColor(ex.status)}>{col(ex.status, 10)}</Text>
              {"  "}
              <Text>{formatDuration(ex.durationMs).padStart(10)}</Text>
              {"    "}
              <Text dimColor>{ex.startedAt}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>j/k: Navigate</Text>
        <Text dimColor>Enter: View detail</Text>
        <Text dimColor>Esc: Back</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Exchange Detail View --

function ExchangeDetailView({
  exchange,
  events,
  width,
  height,
}: {
  exchange: ExchangeRecord;
  events: EventRecord[];
  width: number;
  height: number;
}) {
  const eventColWidth = Math.min(Math.max(Math.floor(width * 0.3), 20), 45);
  const detailsColWidth = Math.max(width - eventColWidth - 28, 10);
  // header(3) + meta(7) + divider(1) + event-header(2) + help(2) + borders(4) = ~19
  const eventRows = Math.max(height - 19, 3);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          Exchange Detail
        </Text>
      </Box>

      {/* Exchange metadata */}
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={width}
      >
        <Text>
          <Text bold>ID: </Text>
          <Text>{exchange.id}</Text>
        </Text>
        <Text>
          <Text bold>Route: </Text>
          <Text>{exchange.routeId}</Text>
        </Text>
        <Text>
          <Text bold>Status: </Text>
          <Text color={statusColor(exchange.status)}>{exchange.status}</Text>
        </Text>
        <Text>
          <Text bold>Started: </Text>
          <Text>{exchange.startedAt}</Text>
          {exchange.completedAt && (
            <Text>
              {"  "}
              <Text bold>Completed: </Text>
              {exchange.completedAt}
            </Text>
          )}
          {exchange.durationMs !== null && (
            <Text>
              {"  "}
              <Text bold>Duration: </Text>
              {formatDuration(exchange.durationMs)}
            </Text>
          )}
        </Text>
        {exchange.error && (
          <Text>
            <Text bold color="red">
              Error:{" "}
            </Text>
            <Text color="red">{exchange.error}</Text>
          </Text>
        )}
      </Box>

      {/* Related events */}
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
          Related Events ({events.length})
        </Text>
        <Text dimColor>{"\u2500".repeat(Math.max(width - 6, 50))}</Text>
        {events.length === 0 ? (
          <Text dimColor>No related events found.</Text>
        ) : (
          events.slice(0, eventRows).map((ev) => (
            <Text key={ev.id ?? ev.timestamp} wrap="truncate">
              <Text dimColor>
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
          ))
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>Esc: Back to exchanges</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Events View --

function EventsView({
  events,
  width,
  height,
}: {
  events: EventRecord[];
  width: number;
  height: number;
}) {
  const eventColWidth = Math.min(Math.max(Math.floor(width * 0.3), 20), 45);
  const detailsColWidth = Math.max(width - eventColWidth - 28, 10);
  const tableRows = Math.max(height - 9, 5);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text bold color="cyan">
          Events
        </Text>
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
          {"  "}
          {"Details"}
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(Math.max(width - 6, 50))}</Text>
        {events.length === 0 ? (
          <Text dimColor>No events recorded yet.</Text>
        ) : (
          events.slice(0, tableRows).map((ev) => (
            <Text key={ev.id ?? ev.timestamp} wrap="truncate">
              <Text dimColor>
                {"  "}
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
          ))
        )}
      </Box>

      <Box marginTop={1} gap={2}>
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

  const [view, setView] = useState<ViewMode>("dashboard");
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [metrics, setMetrics] = useState({
    totalRoutes: 0,
    totalExchanges: 0,
    completedExchanges: 0,
    failedExchanges: 0,
    errorRate: 0,
    avgDurationMs: null as number | null,
  });
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [exchanges, setExchanges] = useState<ExchangeRecord[]>([]);
  const [selectedExchangeIndex, setSelectedExchangeIndex] = useState(0);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [selectedExchange, setSelectedExchange] = useState<
    ExchangeRecord | undefined
  >(undefined);
  const [exchangeEvents, setExchangeEvents] = useState<EventRecord[]>([]);

  const refresh = useCallback(() => {
    try {
      const routeSummary = db.getRouteSummary();
      setRoutes(routeSummary);
      setMetrics(db.getMetrics());

      if (view === "exchanges" && selectedRouteId) {
        setExchanges(db.getExchangesByRoute(selectedRouteId));
      }

      if (view === "events") {
        setEvents(db.getRecentEvents({ limit: Math.max(height - 9, 20) }));
      }
    } catch {
      // Database may be temporarily locked; retry on next tick
    }
  }, [db, view, selectedRouteId, height]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  useInput((input, key) => {
    if (input === "q") {
      db.close();
      exit();
      return;
    }

    if (view === "dashboard") {
      if (input === "j" || key.downArrow) {
        setSelectedRouteIndex((i) => Math.min(i + 1, routes.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedRouteIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const route = routes[selectedRouteIndex];
        if (route) {
          setSelectedRouteId(route.id);
          setSelectedExchangeIndex(0);
          setExchanges(db.getExchangesByRoute(route.id));
          setView("exchanges");
        }
      } else if (input === "e") {
        setEvents(db.getRecentEvents({ limit: Math.max(height - 9, 20) }));
        setView("events");
      }
    } else if (view === "exchanges") {
      if (input === "j" || key.downArrow) {
        setSelectedExchangeIndex((i) => Math.min(i + 1, exchanges.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedExchangeIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const ex = exchanges[selectedExchangeIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id));
          setView("exchange-detail");
        }
      } else if (key.escape || key.backspace || key.delete) {
        setView("dashboard");
      }
    } else if (view === "exchange-detail") {
      if (key.escape || key.backspace || key.delete) {
        setView("exchanges");
      }
    } else if (view === "events") {
      if (key.escape || key.backspace || key.delete) {
        setView("dashboard");
      }
    }
  });

  if (view === "exchange-detail" && selectedExchange) {
    return (
      <ExchangeDetailView
        exchange={selectedExchange}
        events={exchangeEvents}
        width={width}
        height={height}
      />
    );
  }

  if (view === "exchanges") {
    return (
      <ExchangeListView
        routeId={selectedRouteId}
        exchanges={exchanges}
        selectedIndex={selectedExchangeIndex}
        width={width}
        height={height}
      />
    );
  }

  if (view === "events") {
    return <EventsView events={events} width={width} height={height} />;
  }

  return (
    <DashboardView
      routes={routes}
      metrics={metrics}
      selectedIndex={selectedRouteIndex}
      width={width}
      height={height}
    />
  );
}

/**
 * Launch the TUI application.
 *
 * @param dbPath - Path to the telemetry SQLite database
 */
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
