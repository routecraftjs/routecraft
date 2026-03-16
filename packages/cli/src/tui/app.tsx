import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";
import type {
  NavItem,
  DrillView,
  RouteSummary,
  ExchangeRecord,
  EventRecord,
  Metrics,
} from "./types.js";
import { NAV_SECTIONS, ALL_NAV_ITEMS } from "./types.js";
import { barChart, fmtNum, formatDuration } from "./utils.js";
import { CenterOverview } from "./components/center-overview.js";
import { CenterExchangeList } from "./components/center-exchange-list.js";
import { CenterExchangeDetail } from "./components/center-exchange-detail.js";
import { EventsView } from "./components/events-view.js";
import { CapabilityList } from "./components/capability-list.js";

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
  const keymapHeight = 9;
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
