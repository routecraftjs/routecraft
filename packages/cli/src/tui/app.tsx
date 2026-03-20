import { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";
import type {
  NavItem,
  RouteSummary,
  ExchangeRecord,
  EventRecord,
  Metrics,
  RouteActivity,
} from "./types.js";
import { NAV_SECTIONS, ALL_NAV_ITEMS } from "./types.js";
import { fmtNum, formatDuration } from "./utils.js";
import { useScrollList } from "./hooks/use-scroll-list.js";
import { PANEL_TABLE_CHROME, DETAIL_INFO_CHROME, NAV_JUMP } from "./layout.js";
import { Panel } from "./components/panel.js";
import { DotGraph, DEFAULT_STEPS } from "./components/dot-graph.js";
import { CenterExchangeList } from "./components/center-exchange-list.js";
import { CenterExchangeDetail } from "./components/center-exchange-detail.js";
import { EventsView } from "./components/events-view.js";
import { CapabilityList } from "./components/capability-list.js";

/**
 * Focus tracks which panel owns the cursor.
 * - "nav": left panel (route list / nav items)
 * - "center": center panel (exchange list, events, detail)
 */
type Focus = "nav" | "center";

function App({ db }: { db: TelemetryDb }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [activeNav, setActiveNav] = useState<NavItem>("capabilities");
  const [focus, setFocus] = useState<Focus>("nav");
  const [showDetail, setShowDetail] = useState(false);

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
  const [liveTraffic, setLiveTraffic] = useState<number[]>([]);
  const [selectedRouteActivity, setSelectedRouteActivity] = useState<
    RouteActivity | undefined
  >(undefined);
  const routeScroll = useScrollList();
  const [exchanges, setExchanges] = useState<ExchangeRecord[]>([]);
  const exchangeScroll = useScrollList();
  const [selectedExchange, setSelectedExchange] = useState<
    ExchangeRecord | undefined
  >(undefined);
  const [exchangeEvents, setExchangeEvents] = useState<EventRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const eventScroll = useScrollList();
  const [detailScrollIndex, setDetailScrollIndex] = useState(0);
  const PAGE_SIZE = 50;
  const JUMP = NAV_JUMP;

  // Layout dimensions (needed by both refresh and render)
  const leftWidth = Math.max(Math.min(Math.floor(width * 0.18), 26), 16);
  const rightWidth = Math.max(Math.min(Math.floor(width * 0.22), 30), 20);
  const centerWidth = Math.max(width - leftWidth - rightWidth, 30);
  const bodyHeight = Math.max(height - 5, 10);
  const navHeaderRows = 10;
  const navListHeight = Math.max(bodyHeight - navHeaderRows, 3);

  const refresh = useCallback(() => {
    try {
      // Always refresh: routes, metrics, graphs
      const routeSummary = db.getRouteSummary();
      setRoutes(routeSummary);
      setMetrics(db.getMetrics());
      const liveCols = rightWidth - 4;
      setLiveTraffic(db.getLiveTrafficBuckets(liveCols, 5));

      // Only load activity for the currently selected route
      const routeCols = centerWidth - 4;
      const curRoute = routeSummary[routeScroll.selectedIndex];
      if (curRoute) {
        setSelectedRouteActivity(
          db.getSingleRouteActivity(curRoute.id, routeCols, 5),
        );
      }

      // Skip list refresh when cursor is active (user is browsing)
      if (focus === "center") return;

      if (activeNav === "capabilities") {
        const route = routeSummary[routeScroll.selectedIndex];
        if (route) {
          setExchanges(db.getExchangesByRoute(route.id, PAGE_SIZE));
        }
      } else if (activeNav === "exchanges") {
        setExchanges(db.getAllExchanges(PAGE_SIZE));
      } else if (activeNav === "errors") {
        setExchanges(db.getFailedExchanges(PAGE_SIZE));
      } else if (activeNav === "events") {
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    } catch {
      // Database may be temporarily locked
    }
  }, [
    db,
    activeNav,
    routeScroll.selectedIndex,
    rightWidth,
    centerWidth,
    focus,
  ]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  const selectRoute = useCallback(
    (index: number) => {
      routeScroll.moveTo(index, routes.length, navListHeight);
      exchangeScroll.reset();
      const route = routes[index];
      if (route) {
        setExchanges(db.getExchangesByRoute(route.id, PAGE_SIZE));
      }
    },
    [db, routes, routeScroll, exchangeScroll, navListHeight],
  );

  const switchNav = useCallback(
    (nav: NavItem) => {
      setActiveNav(nav);
      setShowDetail(false);
      exchangeScroll.reset();
      if (nav === "capabilities") {
        setFocus("nav");
      } else {
        setFocus("center");
        // Load all for browsing; auto-refresh uses PAGE_SIZE when not focused
        if (nav === "exchanges") {
          setExchanges(db.getAllExchanges());
        } else if (nav === "errors") {
          setExchanges(db.getFailedExchanges());
        }
      }
      if (nav === "events") {
        eventScroll.reset();
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    },
    [db, exchangeScroll, eventScroll],
  );

  const selectedRoute = routes[routeScroll.selectedIndex];

  // Visible row counts mirror the view components
  // Must match CenterExchangeList: 2 (capability + stats) + graphTermRows + 2 (label + spacer)
  const graphTermRows = Math.ceil((DEFAULT_STEPS.length - 1) / 4);
  const exchangeHeaderRows = selectedRoute ? 2 + graphTermRows + 2 : 0;
  const exchangeTableRows = Math.max(
    bodyHeight - PANEL_TABLE_CHROME - exchangeHeaderRows,
    3,
  );
  const eventsTableRows = Math.max(bodyHeight - PANEL_TABLE_CHROME, 5);

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

    // Events view
    if (activeNav === "events") {
      const step = key.ctrl ? JUMP : 1;
      if (input === "j" || key.downArrow) {
        eventScroll.moveBy(step, events.length, eventsTableRows);
      } else if (input === "k" || key.upArrow) {
        eventScroll.moveBy(-step, events.length, eventsTableRows);
      }
      return;
    }

    // Exchange detail (any nav)
    if (showDetail) {
      const hasExtra = selectedExchange?.error ? 2 : 0;
      const detailEventRows = Math.max(
        bodyHeight - DETAIL_INFO_CHROME - hasExtra,
        3,
      );
      // Count group headers: when events span multiple exchanges, each group gets a header row
      const uniqueExchangeIds = new Set(
        exchangeEvents.map((ev) => {
          try {
            const d = JSON.parse(ev.details) as Record<string, unknown>;
            return String(d["exchangeId"] ?? "");
          } catch {
            return "";
          }
        }),
      );
      const groupCount = Math.max(uniqueExchangeIds.size, 1);
      const headerRows = groupCount > 1 ? groupCount : 0;
      const totalDisplayRows = exchangeEvents.length + headerRows;
      const maxScroll = Math.max(totalDisplayRows - detailEventRows - 1, 0);
      const step = key.ctrl ? JUMP : 1;
      if (input === "j" || key.downArrow) {
        setDetailScrollIndex((i) => Math.min(i + step, maxScroll));
      } else if (input === "k" || key.upArrow) {
        setDetailScrollIndex((i) => Math.max(i - step, 0));
      } else if (key.escape || key.backspace || key.delete) {
        setDetailScrollIndex(0);
        setShowDetail(false);
      }
      return;
    }

    // Capabilities: nav focus (left panel)
    if (activeNav === "capabilities" && focus === "nav") {
      if (input === "j" || key.downArrow) {
        selectRoute(Math.min(routeScroll.selectedIndex + 1, routes.length - 1));
      } else if (input === "k" || key.upArrow) {
        selectRoute(Math.max(routeScroll.selectedIndex - 1, 0));
      } else if (key.return) {
        setFocus("center");
        // Load all exchanges for browsing (auto-refresh uses PAGE_SIZE)
        const route = routes[routeScroll.selectedIndex];
        if (route) {
          setExchanges(db.getExchangesByRoute(route.id));
        }
      }
      return;
    }

    // Capabilities: center focus (exchange list)
    if (activeNav === "capabilities" && focus === "center") {
      const step = key.ctrl ? JUMP : 1;
      if (input === "j" || key.downArrow) {
        exchangeScroll.moveBy(step, exchanges.length, exchangeTableRows);
      } else if (input === "k" || key.upArrow) {
        exchangeScroll.moveBy(-step, exchanges.length, exchangeTableRows);
      } else if (key.return) {
        const ex = exchanges[exchangeScroll.selectedIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id, ex.correlationId));
          setShowDetail(true);
        }
      } else if (key.escape || key.backspace || key.delete) {
        setFocus("nav");
        exchangeScroll.reset();
      }
      return;
    }

    // Exchanges / Errors: center focus
    if (activeNav === "exchanges" || activeNav === "errors") {
      const step = key.ctrl ? JUMP : 1;
      if (input === "j" || key.downArrow) {
        exchangeScroll.moveBy(step, exchanges.length, exchangeTableRows);
      } else if (input === "k" || key.upArrow) {
        exchangeScroll.moveBy(-step, exchanges.length, exchangeTableRows);
      } else if (key.return) {
        const ex = exchanges[exchangeScroll.selectedIndex];
        if (ex) {
          setSelectedExchange(ex);
          setExchangeEvents(db.getEventsByExchange(ex.id, ex.correlationId));
          setShowDetail(true);
        }
      }
      return;
    }
  });

  // Determine which panel is active for border highlighting
  const navActive =
    activeNav === "capabilities" && focus === "nav" && !showDetail;
  const centerActive = !navActive;

  // Keymap items based on context
  const keymapItems: { key: string; action: string }[] = [];
  keymapItems.push({ key: "j/k", action: "Navigate" });
  keymapItems.push({ key: "Ctrl+j/k", action: "Jump 10" });
  if (activeNav === "capabilities" && focus === "nav") {
    keymapItems.push({ key: "Enter", action: "Exchanges" });
  }
  if (
    (activeNav === "capabilities" && focus === "center" && !showDetail) ||
    ((activeNav === "exchanges" || activeNav === "errors") && !showDetail)
  ) {
    keymapItems.push({ key: "Enter", action: "Detail" });
  }
  if ((activeNav === "capabilities" && focus === "center") || showDetail) {
    keymapItems.push({ key: "Esc", action: "Back" });
  }
  keymapItems.push({ key: "1..4", action: "Switch view" });
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
          <Panel
            title="NAVIGATION"
            color={navActive ? "cyan" : "gray"}
            width={leftWidth}
            flexGrow={1}
          >
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
                selectedIndex={routeScroll.selectedIndex}
                listOffset={routeScroll.scrollOffset}
                visibleRows={navListHeight}
                width={leftWidth - 6}
              />
            )}
          </Panel>
        </Box>

        {/* Center */}
        {activeNav === "capabilities" && !showDetail && (
          <CenterExchangeList
            capabilityId={selectedRoute?.id ?? ""}
            route={selectedRoute}
            exchanges={exchanges}
            selectedIndex={
              focus === "center" ? exchangeScroll.selectedIndex : -1
            }
            scrollOffset={focus === "center" ? exchangeScroll.scrollOffset : 0}
            width={centerWidth}
            height={bodyHeight}
            color={centerActive ? "cyan" : "gray"}
            activity={selectedRouteActivity}
          />
        )}
        {activeNav === "capabilities" && showDetail && selectedExchange && (
          <CenterExchangeDetail
            exchange={selectedExchange}
            events={exchangeEvents}
            width={centerWidth}
            height={bodyHeight}
            scrollOffset={detailScrollIndex}
            color="cyan"
          />
        )}
        {activeNav === "exchanges" && !showDetail && (
          <CenterExchangeList
            capabilityId="All Capabilities"
            exchanges={exchanges}
            selectedIndex={exchangeScroll.selectedIndex}
            scrollOffset={exchangeScroll.scrollOffset}
            width={centerWidth}
            height={bodyHeight}
            color="cyan"
          />
        )}
        {activeNav === "exchanges" && showDetail && selectedExchange && (
          <CenterExchangeDetail
            exchange={selectedExchange}
            events={exchangeEvents}
            width={centerWidth}
            height={bodyHeight}
            scrollOffset={detailScrollIndex}
            color="cyan"
          />
        )}
        {activeNav === "errors" && !showDetail && (
          <CenterExchangeList
            capabilityId="Failed Exchanges"
            exchanges={exchanges}
            selectedIndex={exchangeScroll.selectedIndex}
            scrollOffset={exchangeScroll.scrollOffset}
            width={centerWidth}
            height={bodyHeight}
            color="cyan"
          />
        )}
        {activeNav === "errors" && showDetail && selectedExchange && (
          <CenterExchangeDetail
            exchange={selectedExchange}
            events={exchangeEvents}
            width={centerWidth}
            height={bodyHeight}
            scrollOffset={detailScrollIndex}
            color="cyan"
          />
        )}
        {activeNav === "events" && (
          <EventsView
            events={events}
            selectedIndex={eventScroll.selectedIndex}
            scrollOffset={eventScroll.scrollOffset}
            width={centerWidth}
            height={bodyHeight}
            color="cyan"
          />
        )}

        {/* Right: Metrics + Keymap */}
        <Box flexDirection="column" width={rightWidth}>
          <Panel title="METRICS" width={rightWidth} flexGrow={1}>
            <DotGraph
              values={liveTraffic}
              columns={rightWidth - 4}
              steps={[
                { max: 0, color: "gray" },
                ...(Array.from({ length: 7 }, (_, i) => ({
                  max: (i + 1) * 5,
                  color: "green",
                })) as { max: number; color: string }[]),
                ...(Array.from({ length: 7 }, (_, i) => ({
                  max: 35 + (i + 1) * 10,
                  color: "yellow",
                })) as { max: number; color: string }[]),
                ...(Array.from({ length: 6 }, (_, i) => ({
                  max: 105 + (i + 1) * 25,
                  color: "red",
                })) as { max: number; color: string }[]),
              ]}
              label="Exchanges per 5s bucket"
            />
            <Text> </Text>
            {(
              [
                ["Exchanges", fmtNum(metrics.totalExchanges), "cyan"],
                ["Completed", fmtNum(metrics.completedExchanges), "green"],
                [
                  "Errors",
                  fmtNum(metrics.failedExchanges),
                  metrics.failedExchanges > 0 ? "red" : "green",
                ],
                [
                  "Dropped",
                  fmtNum(metrics.droppedExchanges),
                  metrics.droppedExchanges > 0 ? "yellow" : "green",
                ],
                [
                  "Error Rate",
                  `${(metrics.errorRate * 100).toFixed(1)}%`,
                  metrics.errorRate > 0.1 ? "red" : "green",
                ],
                ["Avg Duration", formatDuration(metrics.avgDurationMs), ""],
                ["Capabilities", fmtNum(metrics.totalRoutes), ""],
              ] as [string, string, string][]
            ).map(([label, value, color]) => (
              <Box key={label}>
                <Text>{label}:</Text>
                <Box flexGrow={1} justifyContent="flex-end">
                  <Text bold {...(color ? { color } : {})}>
                    {value}
                  </Text>
                </Box>
              </Box>
            ))}
          </Panel>

          <Panel title="KEYMAP" width={rightWidth}>
            {keymapItems.map((item) => (
              <Box key={item.key}>
                <Text>{item.action}</Text>
                <Box flexGrow={1} justifyContent="flex-end">
                  <Text color="yellow">[{item.key}]</Text>
                </Box>
              </Box>
            ))}
          </Panel>
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
