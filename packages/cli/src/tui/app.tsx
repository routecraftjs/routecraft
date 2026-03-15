import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { TelemetryDb } from "./db.js";

/**
 * View modes for the TUI application.
 */
type ViewMode = "dashboard" | "exchanges" | "logs";

/**
 * Route summary with aggregated metrics.
 */
interface RouteSummary {
  id: string;
  contextId: string;
  registeredAt: string;
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

// -- Dashboard View --

function DashboardView({
  routes,
  metrics,
  selectedIndex,
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
}) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          {" "}
          Routecraft TUI - Dashboard{" "}
        </Text>
      </Box>

      {/* Metrics bar */}
      <Box marginTop={1} gap={2}>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            Routes:{" "}
            <Text bold color="cyan">
              {metrics.totalRoutes}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            Exchanges:{" "}
            <Text bold color="cyan">
              {metrics.totalExchanges}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            Errors:{" "}
            <Text bold color={metrics.failedExchanges > 0 ? "red" : "green"}>
              {metrics.failedExchanges}
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            Error Rate:{" "}
            <Text bold color={metrics.errorRate > 0.1 ? "red" : "green"}>
              {(metrics.errorRate * 100).toFixed(1)}%
            </Text>
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            Avg Duration:{" "}
            <Text bold>{formatDuration(metrics.avgDurationMs)}</Text>
          </Text>
        </Box>
      </Box>

      {/* Routes table */}
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        <Text bold dimColor>
          {
            "  Route ID              Status     Total    OK    Fail    Avg Duration"
          }
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(68)}</Text>
        {routes.length === 0 ? (
          <Text dimColor>
            {" "}
            No routes recorded yet. Start a context with telemetry() enabled.
          </Text>
        ) : (
          routes.map((route, i) => (
            <Text key={route.id + route.contextId}>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {truncate(route.id, 20).padEnd(20)}
              </Text>
              {"  "}
              <Text color={statusColor(route.status)}>
                {route.status.padEnd(10)}
              </Text>
              {"  "}
              <Text>{String(route.totalExchanges).padStart(5)}</Text>
              {"  "}
              <Text color="green">
                {String(route.completedExchanges).padStart(4)}
              </Text>
              {"  "}
              <Text
                {...(route.failedExchanges > 0
                  ? { color: "red" as const }
                  : {})}
              >
                {String(route.failedExchanges).padStart(4)}
              </Text>
              {"    "}
              <Text>{formatDuration(route.avgDurationMs).padStart(10)}</Text>
            </Text>
          ))
        )}
      </Box>

      {/* Help bar */}
      <Box marginTop={1} gap={2}>
        <Text dimColor>j/k or Up/Down: Navigate</Text>
        <Text dimColor>Enter: Inspect exchanges</Text>
        <Text dimColor>l: Log stream</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Exchange Inspector View --

function ExchangeView({
  routeId,
  exchanges,
  selectedIndex,
}: {
  routeId: string;
  exchanges: ExchangeRecord[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          {" "}
          Exchange Inspector - {routeId}{" "}
        </Text>
      </Box>

      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        <Text bold dimColor>
          {
            "  Exchange ID                         Status      Duration    Started At"
          }
        </Text>
        <Text dimColor>{"  " + "\u2500".repeat(78)}</Text>
        {exchanges.length === 0 ? (
          <Text dimColor> No exchanges recorded for this route.</Text>
        ) : (
          exchanges.map((ex, i) => (
            <Text key={ex.id + ex.contextId}>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {truncate(ex.id, 34).padEnd(34)}
              </Text>
              {"  "}
              <Text color={statusColor(ex.status)}>{ex.status.padEnd(10)}</Text>
              {"  "}
              <Text>{formatDuration(ex.durationMs).padStart(10)}</Text>
              {"    "}
              <Text dimColor>{ex.startedAt}</Text>
            </Text>
          ))
        )}
        {exchanges.length > 0 && exchanges[selectedIndex]?.error && (
          <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red">Error: {exchanges[selectedIndex]!.error}</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>j/k or Up/Down: Navigate</Text>
        <Text dimColor>Esc/Backspace: Back to dashboard</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Log Stream View --

function LogView({
  events,
  filterText,
}: {
  events: EventRecord[];
  filterText: string;
}) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          {" "}
          Log Stream{filterText ? ` (filter: ${filterText})` : ""}{" "}
        </Text>
      </Box>

      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        height={20}
      >
        {events.length === 0 ? (
          <Text dimColor> No events recorded yet.</Text>
        ) : (
          events.slice(0, 30).map((ev) => (
            <Text key={ev.id ?? ev.timestamp} wrap="truncate">
              <Text dimColor>
                {ev.timestamp.replace("T", " ").slice(0, 19)}
              </Text>
              {"  "}
              <Text color="cyan">{truncate(ev.eventName, 40).padEnd(40)}</Text>
              {"  "}
              <Text>{truncate(ev.details, 60)}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>Esc/Backspace: Back to dashboard</Text>
        <Text dimColor>q: Quit</Text>
      </Box>
    </Box>
  );
}

// -- Main App --

function App({ db }: { db: TelemetryDb }) {
  const { exit } = useApp();

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

  // Refresh data from database
  const refresh = useCallback(() => {
    try {
      const routeSummary = db.getRouteSummary();
      setRoutes(routeSummary);
      setMetrics(db.getMetrics());

      if (view === "exchanges" && selectedRouteId) {
        setExchanges(db.getExchangesByRoute(selectedRouteId));
      }

      if (view === "logs") {
        setEvents(db.getRecentEvents({ limit: 30 }));
      }
    } catch {
      // Database may be temporarily locked; retry on next tick
    }
  }, [db, view, selectedRouteId]);

  // Poll for updates every 2 seconds
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  // Keyboard input handling
  useInput((input, key) => {
    // Quit
    if (input === "q") {
      db.close();
      exit();
      return;
    }

    if (view === "dashboard") {
      // Navigation
      if (input === "j" || key.downArrow) {
        setSelectedRouteIndex((i) => Math.min(i + 1, routes.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedRouteIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        // Drill into route's exchanges
        const route = routes[selectedRouteIndex];
        if (route) {
          setSelectedRouteId(route.id);
          setSelectedExchangeIndex(0);
          setExchanges(db.getExchangesByRoute(route.id));
          setView("exchanges");
        }
      } else if (input === "l") {
        setEvents(db.getRecentEvents({ limit: 30 }));
        setView("logs");
      }
    } else if (view === "exchanges") {
      if (input === "j" || key.downArrow) {
        setSelectedExchangeIndex((i) => Math.min(i + 1, exchanges.length - 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedExchangeIndex((i) => Math.max(i - 1, 0));
      } else if (key.escape || key.backspace || key.delete) {
        setView("dashboard");
      }
    } else if (view === "logs") {
      if (key.escape || key.backspace || key.delete) {
        setView("dashboard");
      }
    }
  });

  if (view === "exchanges") {
    return (
      <ExchangeView
        routeId={selectedRouteId}
        exchanges={exchanges}
        selectedIndex={selectedExchangeIndex}
      />
    );
  }

  if (view === "logs") {
    return <LogView events={events} filterText="" />;
  }

  return (
    <DashboardView
      routes={routes}
      metrics={metrics}
      selectedIndex={selectedRouteIndex}
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
    db = new TelemetryDb(dbPath);
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
