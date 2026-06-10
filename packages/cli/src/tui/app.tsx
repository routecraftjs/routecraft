import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { TelemetryDb } from "./db.js";
import type {
  NavItem,
  RouteSummary,
  ExchangeRecord,
  ExchangeSnapshot,
  EventRecord,
  Metrics,
  RouteActivity,
  AgentSummary,
  ToolSummary,
  AgentRunInfo,
  ToolCallRow,
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
import { EventDetail } from "./components/event-detail.js";
import { ExchangeDeepView } from "./components/exchange-deep-view.js";
import { NavList } from "./components/nav-list.js";
import { AgentRunList } from "./components/agent-run-list.js";
import { AgentRunDetail } from "./components/agent-run-detail.js";
import { ToolCallList } from "./components/tool-call-list.js";
import { ToolCallDetail } from "./components/tool-call-detail.js";
import { theme, selectedProps } from "./theme.js";
import { version } from "../../package.json";

/** Status dot for a capability in the left nav. */
function routeDot(route: RouteSummary): string {
  if (route.failedExchanges > 0) return theme.error;
  if (route.totalExchanges > 0) return theme.success;
  return theme.warn;
}

/** Status dot for an agent: red on errors, green once run, yellow when idle. */
function agentDot(agent: AgentSummary): string {
  if (agent.errorCount > 0) return theme.error;
  if (agent.runCount > 0) return theme.success;
  return theme.warn;
}

/** Status dot for a tool: red on errors, green once called, yellow when idle. */
function toolDot(tool: ToolSummary): string {
  if (tool.errorCount > 0) return theme.error;
  if (tool.callCount > 0) return theme.success;
  return theme.warn;
}

/**
 * Full 20-level threshold ladder for the metrics traffic graph: green for
 * low volume, yellow for mid, red for high.
 */
const METRIC_LADDER: { max: number; color: string }[] = [
  ...Array.from({ length: 7 }, (_, i) => ({
    max: (i + 1) * 5,
    color: "green",
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    max: 35 + (i + 1) * 10,
    color: "yellow",
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    max: 105 + (i + 1) * 25,
    color: "red",
  })),
];

/**
 * Sample `levels` thresholds evenly from the ladder so the graph can
 * shrink to the rows the metrics panel has available (4 levels = 1
 * terminal row of braille).
 */
function metricSteps(levels: number): { max: number; color: string }[] {
  const picked = Array.from({ length: levels }, (_, i) => {
    const idx = Math.min(
      Math.ceil(((i + 1) * METRIC_LADDER.length) / levels) - 1,
      METRIC_LADDER.length - 1,
    );
    return METRIC_LADDER[idx]!;
  });
  return [{ max: 0, color: "gray" }, ...picked];
}

/**
 * One level of drill-down above the tab root.
 *
 * The TUI's navigation is an explicit stack: the tab root (empty stack)
 * means the left nav owns the cursor; "browse" means the center list owns
 * it; the detail views push on top of that. Enter pushes, Esc pops, and
 * the top of the stack alone decides both key handling and what the
 * center pane renders, so a view can never be in two states at once.
 *
 * - "browse": center list (exchanges, runs, tool calls, events)
 * - "exchange": one exchange with its related events
 * - "event": scrollable JSON of one event
 * - "snapshot": scrollable JSON of an exchange's headers/body snapshot
 * - "agent-run": one agent run (model, tokens, tool-call timeline)
 * - "tool-call": scrollable JSON of one tool call's input/output
 */
type ViewKind =
  | "browse"
  | "exchange"
  | "event"
  | "snapshot"
  | "agent-run"
  | "tool-call";

/** Views whose body is a scrollable JSON document. */
const JSON_VIEWS: ReadonlySet<ViewKind> = new Set([
  "event",
  "snapshot",
  "tool-call",
]);

/**
 * Group an exchange's related events by exchangeId (parent first),
 * mirroring the display rows CenterExchangeDetail builds. Shared by the
 * input handler (resolving the cursor row back to an event) and the
 * live refresh (pinning follow mode to the newest row), so the two can
 * never disagree about row positions.
 */
function buildEventGroups(
  events: EventRecord[],
  parentId: string,
): Map<string, EventRecord[]> {
  const groups = new Map<string, EventRecord[]>();
  groups.set(parentId, []);
  for (const ev of events) {
    try {
      const d = JSON.parse(ev.details) as Record<string, unknown>;
      const exId = String(d["exchangeId"] ?? "");
      const gKey = !exId || exId === parentId ? parentId : exId;
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey)!.push(ev);
    } catch {
      groups.get(parentId)!.push(ev);
    }
  }
  return groups;
}

/**
 * Number of display rows in the exchange detail: every event plus one
 * header row per group when the events span multiple exchanges.
 */
function countDisplayRows(events: EventRecord[], parentId: string): number {
  const groups = buildEventGroups(events, parentId);
  return events.length + (groups.size > 1 ? groups.size : 0);
}

/**
 * Root TUI component. Exported for tests; not part of the public CLI
 * surface.
 *
 * @internal
 */
export function App({ db }: { db: TelemetryDb }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [activeNav, setActiveNav] = useState<NavItem>("capabilities");
  const [stack, setStack] = useState<ViewKind[]>([]);
  const current: ViewKind | "root" = stack.at(-1) ?? "root";

  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({
    totalRoutes: 0,
    totalExchanges: 0,
    completedExchanges: 0,
    failedExchanges: 0,
    droppedExchanges: 0,
    errorRate: 0,
    avgDurationMs: null,
    p90DurationMs: null,
    p95DurationMs: null,
    p99DurationMs: null,
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
  const detailScroll = useScrollList();
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | undefined>(
    undefined,
  );
  /** Shared scroll offset for the JSON views (only one is open at a time). */
  const [jsonScroll, setJsonScroll] = useState(0);
  const [exchangeSnapshot, setExchangeSnapshot] =
    useState<ExchangeSnapshot | null>(null);

  // Agents tab state
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const agentScroll = useScrollList();
  const [selectedRun, setSelectedRun] = useState<ExchangeRecord | undefined>(
    undefined,
  );
  const [agentRunInfo, setAgentRunInfo] = useState<AgentRunInfo | null>(null);
  const [agentRunInfos, setAgentRunInfos] = useState<Map<string, AgentRunInfo>>(
    new Map(),
  );
  const [agentRunToolCalls, setAgentRunToolCalls] = useState<ToolCallRow[]>([]);
  const agentRunScroll = useScrollList();

  // List filter (`/` in a browse list) and follow mode (`f`)
  const [filter, setFilter] = useState("");
  const [filterTyping, setFilterTyping] = useState(false);
  const [follow, setFollow] = useState(false);

  // Tools tab state
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const toolScroll = useScrollList();
  const [toolCalls, setToolCalls] = useState<ToolCallRow[]>([]);
  const toolCallScroll = useScrollList();
  const [selectedToolCall, setSelectedToolCall] = useState<
    ToolCallRow | undefined
  >(undefined);

  const PAGE_SIZE = 50;
  const JUMP = NAV_JUMP;

  const push = useCallback((view: ViewKind) => {
    setStack((s) => [...s, view]);
    setJsonScroll(0);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    setJsonScroll(0);
  }, []);

  // Layout dimensions (needed by both refresh and render)
  const leftWidth = Math.max(Math.min(Math.floor(width * 0.18), 26), 16);
  const rightWidth = Math.max(Math.min(Math.floor(width * 0.22), 30), 20);
  const centerWidth = Math.max(width - leftWidth - rightWidth, 30);
  // 1 header line + 1 footer line + 2 rows of slack.
  const bodyHeight = Math.max(height - 4, 10);
  const navHeaderRows = 10;
  const navListHeight = Math.max(bodyHeight - navHeaderRows, 3);
  // Metrics panel fixed rows: 2 border + 2 title/sep + 1 graph label +
  // 2 blanks + 1 THROUGHPUT + 6 rows + 1 LATENCY + 4 rows = 19. Whatever
  // is left can hold braille graph rows (4 levels per row, 1..5 rows).
  const metricsGraphLevels = Math.max(Math.min(bodyHeight - 19, 5), 1) * 4;
  // Tool-call timeline inside the agent-run detail (header is 6 rows).
  // Defined here (not with the other table row counts) because the live
  // refresh also needs it to pin follow mode to the newest call.
  const runToolRows = Math.max(bodyHeight - 6 - PANEL_TABLE_CHROME, 3);

  // Identity of any open detail views, as primitives, so the polling
  // callback does not need the selected objects themselves as deps
  // (those are replaced with fresh instances every poll, which would
  // recreate the interval each tick).
  const openExchangeId = stack.includes("exchange")
    ? selectedExchange?.id
    : undefined;
  const openExchangeCorr = stack.includes("exchange")
    ? selectedExchange?.correlationId
    : undefined;
  const openRunId = stack.includes("agent-run") ? selectedRun?.id : undefined;
  const openCallId =
    current === "tool-call" ? selectedToolCall?.toolCallId : undefined;
  const openCallTool =
    current === "tool-call" ? selectedToolCall?.toolName : undefined;
  // Selected nav-list identities as primitives, for the same reason.
  const selAgentKey = agents[agentScroll.selectedIndex]?.key;
  const selAgentSource = agents[agentScroll.selectedIndex]?.source;
  const selToolName = tools[toolScroll.selectedIndex]?.name;

  /**
   * Load an agent's runs plus the per-run info (model, tokens) the runs
   * list renders as columns.
   */
  const loadAgentRuns = useCallback(
    (
      agent: { key: string; source: "registered" | "inline" } | undefined,
      limit?: number,
    ) => {
      if (!agent) {
        setExchanges([]);
        setAgentRunInfos(new Map());
        return;
      }
      const runs =
        limit !== undefined
          ? db.getAgentRuns(agent.key, agent.source, limit)
          : db.getAgentRuns(agent.key, agent.source);
      setExchanges(runs);
      setAgentRunInfos(db.getAgentRunInfos(runs.map((r) => r.id)));
    },
    [db],
  );

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

      // Agent/tool nav lists refresh at the tab root so newly-registered
      // or newly-run agents and tools appear without re-entering the tab.
      // While drilled in they stay frozen: the lists are sorted by recent
      // activity, so a live resort would move the index-based selection
      // to a different agent under the open drill-down.
      let agentsList: AgentSummary[] | undefined;
      let toolsList: ToolSummary[] | undefined;
      if (stack.length === 0) {
        if (activeNav === "agents") {
          agentsList = db.getAgents();
          setAgents(agentsList);
        } else if (activeNav === "tools") {
          toolsList = db.getTools();
          setTools(toolsList);
        }
      }

      // Detail views stay live: the open exchange / agent run re-reads
      // its events and tool calls every poll. New rows only append, so
      // the cursor keeps its position; with follow on, the cursor pins
      // to the newest row instead.
      const top = stack.at(-1);
      if (openExchangeId) {
        const fresh = db.getExchangeById(openExchangeId);
        if (fresh) setSelectedExchange(fresh);
        const evs = db.getEventsByExchange(
          openExchangeId,
          openExchangeCorr ?? "",
        );
        setExchangeEvents(evs);
        if (follow && top === "exchange") {
          const hasExtra = fresh?.error ? 2 : 0;
          const rows = Math.max(bodyHeight - DETAIL_INFO_CHROME - hasExtra, 3);
          const total = countDisplayRows(evs, openExchangeId);
          detailScroll.moveTo(total - 1, total, rows);
        }
      }
      if (openRunId) {
        const freshRun = db.getExchangeById(openRunId);
        if (freshRun) setSelectedRun(freshRun);
        setAgentRunInfo(db.getAgentRunInfo(openRunId));
        const calls = db.getAgentRunToolCalls(openRunId);
        setAgentRunToolCalls(calls);
        if (follow && top === "agent-run") {
          agentRunScroll.moveTo(calls.length - 1, calls.length, runToolRows);
        }
        // An open tool-call document refreshes in place (e.g. a pending
        // call gains its output when the result event lands).
        if (openCallId) {
          const freshCall = calls.find((c) => c.toolCallId === openCallId);
          if (freshCall) setSelectedToolCall(freshCall);
        }
      } else if (openCallId && openCallTool) {
        // Tool-call opened from the Tools tab (no agent run on the stack)
        const freshCall = db
          .getToolCalls(openCallTool)
          .find((c) => c.toolCallId === openCallId);
        if (freshCall) setSelectedToolCall(freshCall);
      }

      // Browse lists stay frozen while the user is in them, unless
      // follow mode keeps the active browse list tailing.
      if (stack.length > 0) {
        const following = follow && top === "browse";
        if (!following) return;
      }

      if (activeNav === "capabilities") {
        const route = routeSummary[routeScroll.selectedIndex];
        if (route) {
          setExchanges(db.getExchangesByRoute(route.id, PAGE_SIZE));
        }
      } else if (activeNav === "agents") {
        const agent = agentsList
          ? agentsList[agentScroll.selectedIndex]
          : selAgentKey && selAgentSource
            ? { key: selAgentKey, source: selAgentSource }
            : undefined;
        loadAgentRuns(agent, PAGE_SIZE);
      } else if (activeNav === "tools") {
        const toolName = toolsList
          ? toolsList[toolScroll.selectedIndex]?.name
          : selToolName;
        setToolCalls(toolName ? db.getToolCalls(toolName) : []);
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
    agentScroll.selectedIndex,
    toolScroll.selectedIndex,
    rightWidth,
    centerWidth,
    bodyHeight,
    runToolRows,
    stack,
    follow,
    loadAgentRuns,
    openExchangeId,
    openExchangeCorr,
    openRunId,
    openCallId,
    openCallTool,
    selAgentKey,
    selAgentSource,
    selToolName,
    detailScroll.moveTo,
    agentRunScroll.moveTo,
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

  const selectAgent = useCallback(
    (index: number) => {
      agentScroll.moveTo(index, agents.length, navListHeight);
      exchangeScroll.reset();
      loadAgentRuns(agents[index], PAGE_SIZE);
    },
    [agents, agentScroll, exchangeScroll, navListHeight, loadAgentRuns],
  );

  const selectTool = useCallback(
    (index: number) => {
      toolScroll.moveTo(index, tools.length, navListHeight);
      toolCallScroll.reset();
      const tool = tools[index];
      if (tool) {
        setToolCalls(db.getToolCalls(tool.name));
      }
    },
    [db, tools, toolScroll, toolCallScroll, navListHeight],
  );

  const switchNav = useCallback(
    (nav: NavItem) => {
      setActiveNav(nav);
      setStack([]);
      setJsonScroll(0);
      setFilter("");
      setFilterTyping(false);
      setFollow(false);
      exchangeScroll.reset();
      if (nav === "agents") {
        agentScroll.reset();
        const list = db.getAgents();
        setAgents(list);
        loadAgentRuns(list[0], PAGE_SIZE);
      } else if (nav === "tools") {
        toolScroll.reset();
        toolCallScroll.reset();
        const list = db.getTools();
        setTools(list);
        const tool = list[0];
        setToolCalls(tool ? db.getToolCalls(tool.name) : []);
      } else if (nav === "exchanges") {
        setExchanges(db.getAllExchanges(PAGE_SIZE));
      } else if (nav === "errors") {
        setExchanges(db.getFailedExchanges(PAGE_SIZE));
      } else if (nav === "events") {
        eventScroll.reset();
        setEvents(db.getRecentEvents({ limit: 200 }));
      }
    },
    [
      db,
      exchangeScroll,
      eventScroll,
      agentScroll,
      toolScroll,
      toolCallScroll,
      loadAgentRuns,
    ],
  );

  // Client-side `/` filter over the active browse list. The lists are
  // frozen while browsing (unless follow mode reloads them), so the
  // filter only has to run over what is already in memory.
  const filterQuery = filter.trim().toLowerCase();
  const filterMatch = (...fields: Array<string | null>): boolean =>
    filterQuery === "" ||
    fields.some((f) => f !== null && f.toLowerCase().includes(filterQuery));
  const visibleExchanges = filterQuery
    ? exchanges.filter((ex) => filterMatch(ex.id, ex.routeId, ex.status))
    : exchanges;
  const visibleToolCalls = filterQuery
    ? toolCalls.filter((c) =>
        filterMatch(c.toolName, c.routeId, c.exchangeId, c.status),
      )
    : toolCalls;
  const visibleEvents = filterQuery
    ? events.filter((ev) => filterMatch(ev.eventName, ev.details))
    : events;

  /** Reset browse-list cursors after the filter narrows the data. */
  const resetBrowseScrolls = useCallback(() => {
    exchangeScroll.reset();
    toolCallScroll.reset();
    eventScroll.reset();
  }, [exchangeScroll, toolCallScroll, eventScroll]);

  const selectedRoute = routes[routeScroll.selectedIndex];
  const selectedAgent = agents[agentScroll.selectedIndex];
  const selectedTool = tools[toolScroll.selectedIndex];

  // Visible row counts mirror the view components
  // Must match CenterExchangeList: 2 (capability + stats) + graphTermRows + 2 (label + spacer)
  const graphTermRows = Math.ceil((DEFAULT_STEPS.length - 1) / 4);
  const exchangeHeaderRows = selectedRoute ? 2 + graphTermRows + 2 : 0;
  const exchangeTableRows = Math.max(
    bodyHeight - PANEL_TABLE_CHROME - exchangeHeaderRows,
    3,
  );
  const eventsTableRows = Math.max(bodyHeight - PANEL_TABLE_CHROME, 5);
  // Plain (header-less) center tables: agent runs and tool-call lists.
  const plainTableRows = Math.max(bodyHeight - PANEL_TABLE_CHROME, 3);

  /**
   * Open the exchange detail for the given exchange. A still-running
   * exchange opens with follow on so new events tail in live.
   */
  const openExchange = useCallback(
    (ex: ExchangeRecord) => {
      setSelectedExchange(ex);
      setExchangeEvents(db.getEventsByExchange(ex.id, ex.correlationId));
      detailScroll.reset();
      setFollow(ex.status === "started");
      push("exchange");
    },
    [db, detailScroll, push],
  );

  /**
   * Open the exchange a tool call ran in. Synthesizes a minimal record
   * when the dispatching exchange was not separately recorded (mirrors
   * getAgentRuns), so the jump always lands somewhere useful.
   */
  const openExchangeForCall = useCallback(
    (call: ToolCallRow) => {
      if (!call.exchangeId) return;
      const ex = db.getExchangeById(call.exchangeId) ?? {
        id: call.exchangeId,
        routeId: call.routeId,
        contextId: "",
        correlationId: "",
        status: "started",
        startedAt: call.timestamp,
        completedAt: null,
        durationMs: null,
        error: null,
      };
      openExchange(ex);
    },
    [db, openExchange],
  );

  useInput((input, key) => {
    // Filter typing mode captures all printable input
    if (filterTyping) {
      if (key.return) {
        setFilterTyping(false);
      } else if (key.escape) {
        setFilterTyping(false);
        setFilter("");
        resetBrowseScrolls();
      } else if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        resetBrowseScrolls();
      } else if (input && !key.ctrl && !key.meta) {
        setFilter((f) => f + input);
        resetBrowseScrolls();
      }
      return;
    }

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

    const step = key.ctrl ? JUMP : 1;
    const down = input === "j" || key.downArrow;
    const up = input === "k" || key.upArrow;
    const back = key.escape || key.backspace || key.delete;

    // Browse-list chrome shared by every tab: filter, follow, leave
    if (current === "browse") {
      if (input === "/") {
        setFilterTyping(true);
        return;
      }
      if (input === "f") {
        setFollow((v) => !v);
        return;
      }
      // Moving the cursor freezes the list again
      if ((down || up) && follow) setFollow(false);
      if (back) {
        pop();
        setFilter("");
        setFollow(false);
        resetBrowseScrolls();
        return;
      }
    }

    // JSON document views: scroll, Esc pops
    if (current !== "root" && JSON_VIEWS.has(current)) {
      if (input === "x" && current === "tool-call" && selectedToolCall) {
        openExchangeForCall(selectedToolCall);
        return;
      }
      if (down) {
        setJsonScroll((i) => i + step);
      } else if (up) {
        setJsonScroll((i) => Math.max(i - step, 0));
      } else if (back) {
        pop();
      }
      return;
    }

    // Agent-run detail: browse the live tool-call timeline
    if (current === "agent-run") {
      if (input === "f") {
        setFollow((v) => !v);
        return;
      }
      if (input === "x" && selectedRun) {
        // A run is one exchange: jump to its exchange detail (related
        // events; `e` from there opens the body/headers snapshot).
        openExchange(selectedRun);
        return;
      }
      if ((down || up) && follow) setFollow(false);
      if (down) {
        agentRunScroll.moveBy(step, agentRunToolCalls.length, runToolRows);
      } else if (up) {
        agentRunScroll.moveBy(-step, agentRunToolCalls.length, runToolRows);
      } else if (key.return) {
        const call = agentRunToolCalls[agentRunScroll.selectedIndex];
        if (call) {
          setSelectedToolCall(call);
          push("tool-call");
        }
      } else if (back) {
        pop();
        setFollow(false);
        agentRunScroll.reset();
      }
      return;
    }

    // Exchange detail: browse the live related-events list, open one,
    // or the snapshot
    if (current === "exchange") {
      if (input === "f") {
        setFollow((v) => !v);
        return;
      }
      if ((down || up) && follow) setFollow(false);
      const hasExtra = selectedExchange?.error ? 2 : 0;
      const detailEventRows = Math.max(
        bodyHeight - DETAIL_INFO_CHROME - hasExtra,
        3,
      );
      const parentId = selectedExchange?.id ?? "";
      const totalDisplayRows = countDisplayRows(exchangeEvents, parentId);
      if (down) {
        detailScroll.moveBy(step, totalDisplayRows, detailEventRows);
      } else if (up) {
        detailScroll.moveBy(-step, totalDisplayRows, detailEventRows);
      } else if (key.return) {
        // Resolve the selected display row to an EventRecord (group
        // headers occupy rows when events span multiple exchanges)
        let rowIndex = 0;
        let targetEvent: EventRecord | undefined;
        const groups = buildEventGroups(exchangeEvents, parentId);
        const hasChildren = groups.size > 1;
        for (const [, groupEvents] of groups) {
          if (hasChildren) rowIndex++; // header row
          for (const ev of groupEvents) {
            if (rowIndex === detailScroll.selectedIndex) {
              targetEvent = ev;
            }
            rowIndex++;
          }
        }
        if (targetEvent) {
          setSelectedEvent(targetEvent);
          push("event");
        }
      } else if (input === "e" && selectedExchange) {
        const snapshot = db.getExchangeSnapshot(selectedExchange.id);
        setExchangeSnapshot(snapshot);
        push("snapshot");
      } else if (back) {
        detailScroll.reset();
        setFollow(false);
        pop();
      }
      return;
    }

    // Tab roots and browse lists
    if (activeNav === "events") {
      if (current === "root") {
        if (key.return) push("browse");
        return;
      }
      if (down) {
        eventScroll.moveBy(step, visibleEvents.length, eventsTableRows);
      } else if (up) {
        eventScroll.moveBy(-step, visibleEvents.length, eventsTableRows);
      } else if (key.return) {
        const ev = visibleEvents[eventScroll.selectedIndex];
        if (ev) {
          setSelectedEvent(ev);
          push("event");
        }
      }
      return;
    }

    if (activeNav === "agents") {
      if (current === "root") {
        if (down) {
          selectAgent(
            Math.min(agentScroll.selectedIndex + 1, agents.length - 1),
          );
        } else if (up) {
          selectAgent(Math.max(agentScroll.selectedIndex - 1, 0));
        } else if (key.return) {
          push("browse");
          loadAgentRuns(agents[agentScroll.selectedIndex]);
        }
        return;
      }
      // Browse the agent's runs
      if (down) {
        exchangeScroll.moveBy(step, visibleExchanges.length, plainTableRows);
      } else if (up) {
        exchangeScroll.moveBy(-step, visibleExchanges.length, plainTableRows);
      } else if (key.return) {
        const ex = visibleExchanges[exchangeScroll.selectedIndex];
        if (ex) {
          setSelectedRun(ex);
          const info = db.getAgentRunInfo(ex.id);
          setAgentRunInfo(info);
          setAgentRunToolCalls(db.getAgentRunToolCalls(ex.id));
          agentRunScroll.reset();
          // A run still in flight opens with follow on so the tool-call
          // timeline tails live while the agent works.
          setFollow(ex.status === "started" || info?.status === "running");
          push("agent-run");
        }
      } else if (input === "x") {
        // A run is one exchange: open its exchange detail directly
        const ex = visibleExchanges[exchangeScroll.selectedIndex];
        if (ex) openExchange(ex);
      }
      return;
    }

    if (activeNav === "tools") {
      if (current === "root") {
        if (down) {
          selectTool(Math.min(toolScroll.selectedIndex + 1, tools.length - 1));
        } else if (up) {
          selectTool(Math.max(toolScroll.selectedIndex - 1, 0));
        } else if (key.return) {
          push("browse");
          const tool = tools[toolScroll.selectedIndex];
          if (tool) {
            setToolCalls(db.getToolCalls(tool.name));
          }
        }
        return;
      }
      // Browse the selected tool's calls
      if (down) {
        toolCallScroll.moveBy(step, visibleToolCalls.length, plainTableRows);
      } else if (up) {
        toolCallScroll.moveBy(-step, visibleToolCalls.length, plainTableRows);
      } else if (key.return) {
        const call = visibleToolCalls[toolCallScroll.selectedIndex];
        if (call) {
          setSelectedToolCall(call);
          push("tool-call");
        }
      } else if (input === "x") {
        // Jump to the exchange this call ran in
        const call = visibleToolCalls[toolCallScroll.selectedIndex];
        if (call) openExchangeForCall(call);
      }
      return;
    }

    // Capabilities / Exchanges / Errors: exchange lists
    if (current === "root") {
      if (activeNav === "capabilities") {
        if (down) {
          selectRoute(
            Math.min(routeScroll.selectedIndex + 1, routes.length - 1),
          );
        } else if (up) {
          selectRoute(Math.max(routeScroll.selectedIndex - 1, 0));
        } else if (key.return) {
          push("browse");
          // Load all exchanges for browsing (auto-refresh uses PAGE_SIZE)
          const route = routes[routeScroll.selectedIndex];
          if (route) {
            setExchanges(db.getExchangesByRoute(route.id));
          }
        }
      } else if (key.return) {
        push("browse");
        // Load full data set for browsing
        if (activeNav === "exchanges") {
          setExchanges(db.getAllExchanges());
        } else {
          setExchanges(db.getFailedExchanges());
        }
      }
      return;
    }
    // Browse the exchange list
    if (down) {
      exchangeScroll.moveBy(step, visibleExchanges.length, exchangeTableRows);
    } else if (up) {
      exchangeScroll.moveBy(-step, visibleExchanges.length, exchangeTableRows);
    } else if (key.return) {
      const ex = visibleExchanges[exchangeScroll.selectedIndex];
      if (ex) openExchange(ex);
    }
  });

  // Left panel owns the cursor when a tab with a nav list is at its root
  const navActive =
    (activeNav === "capabilities" ||
      activeNav === "agents" ||
      activeNav === "tools") &&
    current === "root";
  const browsing = current === "browse";

  // Contextual key hints for the footer
  const keymapItems: { key: string; action: string }[] = [];
  if (current !== "root" && JSON_VIEWS.has(current)) {
    keymapItems.push({ key: "j/k", action: "Scroll" });
    keymapItems.push({ key: "C-j/k", action: "Jump" });
    if (current === "tool-call") {
      keymapItems.push({ key: "x", action: "Exchange" });
    }
    keymapItems.push({ key: "Esc", action: "Back" });
  } else if (current === "agent-run") {
    keymapItems.push({ key: "j/k", action: "Navigate" });
    keymapItems.push({ key: "Enter", action: "Tool I/O" });
    keymapItems.push({ key: "x", action: "Exchange" });
    keymapItems.push({ key: "f", action: "Follow" });
    keymapItems.push({ key: "Esc", action: "Back" });
  } else if (current === "exchange") {
    keymapItems.push({ key: "j/k", action: "Navigate" });
    keymapItems.push({ key: "Enter", action: "Event" });
    keymapItems.push({ key: "e", action: "Snapshot" });
    keymapItems.push({ key: "f", action: "Follow" });
    keymapItems.push({ key: "Esc", action: "Back" });
  } else if (browsing) {
    keymapItems.push({ key: "j/k", action: "Navigate" });
    keymapItems.push({ key: "C-j/k", action: "Jump" });
    keymapItems.push({ key: "Enter", action: "Detail" });
    if (activeNav === "agents" || activeNav === "tools") {
      keymapItems.push({ key: "x", action: "Exchange" });
    }
    keymapItems.push({ key: "/", action: "Filter" });
    keymapItems.push({ key: "f", action: "Follow" });
    keymapItems.push({ key: "Esc", action: "Back" });
  } else {
    keymapItems.push({ key: "j/k", action: "Navigate" });
    if (activeNav === "capabilities") {
      keymapItems.push({ key: "Enter", action: "Exchanges" });
    } else if (activeNav === "agents") {
      keymapItems.push({ key: "Enter", action: "Runs" });
    } else if (activeNav === "tools") {
      keymapItems.push({ key: "Enter", action: "Calls" });
    } else {
      keymapItems.push({ key: "Enter", action: "Browse" });
    }
  }
  keymapItems.push({ key: "1-6", action: "View" });
  keymapItems.push({ key: "q", action: "Quit" });

  // Breadcrumb: where am I in the drill-down?
  const crumbs: string[] = [];
  {
    const tabLabel =
      ALL_NAV_ITEMS.find((n) => n.key === activeNav)?.label ?? activeNav;
    crumbs.push(tabLabel);
    if (stack.length > 0) {
      if (activeNav === "capabilities" && selectedRoute) {
        crumbs.push(selectedRoute.id);
      } else if (activeNav === "agents" && selectedAgent) {
        crumbs.push(selectedAgent.key);
      } else if (activeNav === "tools" && selectedTool) {
        crumbs.push(selectedTool.name);
      }
    }
    for (const view of stack) {
      if (view === "exchange" && selectedExchange) {
        crumbs.push(selectedExchange.id.slice(0, 8));
      } else if (view === "agent-run" && selectedRun) {
        crumbs.push(`run ${selectedRun.id.slice(0, 8)}`);
      } else if (view === "tool-call" && selectedToolCall) {
        crumbs.push(selectedToolCall.toolName);
      } else if (view === "event" && selectedEvent) {
        crumbs.push(selectedEvent.eventName);
      } else if (view === "snapshot") {
        crumbs.push("snapshot");
      }
    }
  }

  // Center pane: the top of the stack decides, independent of the tab
  let center: ReactNode;
  if (current === "event" && selectedEvent) {
    center = (
      <EventDetail
        event={selectedEvent}
        width={centerWidth}
        height={bodyHeight}
        scrollOffset={jsonScroll}
      />
    );
  } else if (current === "snapshot" && selectedExchange) {
    center = (
      <ExchangeDeepView
        exchange={selectedExchange}
        snapshot={exchangeSnapshot}
        width={centerWidth}
        height={bodyHeight}
        scrollOffset={jsonScroll}
      />
    );
  } else if (current === "tool-call" && selectedToolCall) {
    center = (
      <ToolCallDetail
        call={selectedToolCall}
        width={centerWidth}
        height={bodyHeight}
        scrollOffset={jsonScroll}
      />
    );
  } else if (current === "agent-run" && selectedRun) {
    center = (
      <AgentRunDetail
        agentKey={selectedAgent?.key ?? ""}
        run={selectedRun}
        info={agentRunInfo}
        toolCalls={agentRunToolCalls}
        selectedIndex={agentRunScroll.selectedIndex}
        scrollOffset={agentRunScroll.scrollOffset}
        width={centerWidth}
        height={bodyHeight}
      />
    );
  } else if (current === "exchange" && selectedExchange) {
    center = (
      <CenterExchangeDetail
        exchange={selectedExchange}
        events={exchangeEvents}
        width={centerWidth}
        height={bodyHeight}
        selectedIndex={detailScroll.selectedIndex}
        scrollOffset={detailScroll.scrollOffset}
        color={theme.accent}
      />
    );
  } else if (activeNav === "events") {
    center = (
      <EventsView
        events={visibleEvents}
        selectedIndex={browsing ? eventScroll.selectedIndex : -1}
        scrollOffset={browsing ? eventScroll.scrollOffset : 0}
        width={centerWidth}
        height={bodyHeight}
        color={browsing ? theme.accent : theme.muted}
      />
    );
  } else if (activeNav === "agents") {
    center = (
      <AgentRunList
        agentKey={selectedAgent?.key ?? ""}
        runs={visibleExchanges}
        infos={agentRunInfos}
        selectedIndex={browsing ? exchangeScroll.selectedIndex : -1}
        scrollOffset={browsing ? exchangeScroll.scrollOffset : 0}
        width={centerWidth}
        height={bodyHeight}
        color={browsing ? theme.accent : theme.muted}
      />
    );
  } else if (activeNav === "tools") {
    center = (
      <ToolCallList
        toolName={selectedTool?.name ?? ""}
        calls={visibleToolCalls}
        selectedIndex={browsing ? toolCallScroll.selectedIndex : -1}
        scrollOffset={browsing ? toolCallScroll.scrollOffset : 0}
        width={centerWidth}
        height={bodyHeight}
        color={browsing ? theme.accent : theme.muted}
      />
    );
  } else {
    center = (
      <CenterExchangeList
        capabilityId={
          activeNav === "capabilities"
            ? (selectedRoute?.id ?? "")
            : activeNav === "exchanges"
              ? "All Capabilities"
              : "Failed Exchanges"
        }
        {...(activeNav === "capabilities" && selectedRoute
          ? { route: selectedRoute }
          : {})}
        activity={
          activeNav === "capabilities" ? selectedRouteActivity : undefined
        }
        exchanges={visibleExchanges}
        selectedIndex={browsing ? exchangeScroll.selectedIndex : -1}
        scrollOffset={browsing ? exchangeScroll.scrollOffset : 0}
        width={centerWidth}
        height={bodyHeight}
        color={browsing ? theme.accent : theme.muted}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header: wordmark + product term + breadcrumb, single line (brand:
          the wordmark is never all-capped; cobalt stays reserved for
          active states). */}
      <Box paddingX={1} width={width}>
        <Text bold>Routecraft</Text>
        <Text dimColor>
          {"  "}craft tui{"  "}v{version}
        </Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text wrap="truncate">
            {crumbs.map((crumb, i) => (
              <Text key={`${crumb}-${i}`}>
                {i > 0 && <Text dimColor> › </Text>}
                <Text
                  {...(i === crumbs.length - 1 && crumbs.length > 1
                    ? { color: theme.accent }
                    : { dimColor: true })}
                >
                  {crumb}
                </Text>
              </Text>
            ))}
          </Text>
        </Box>
      </Box>

      {/* 3-column body */}
      <Box flexDirection="row" width={width} flexGrow={1}>
        {/* Left: navigation */}
        <Box flexDirection="column" width={leftWidth}>
          <Panel
            title="NAVIGATION"
            color={navActive ? theme.accent : theme.muted}
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
                  <Text key={item.key} wrap="truncate">
                    <Text {...selectedProps(activeNav === item.key)}>
                      {activeNav === item.key ? "> " : "  "}
                      {item.label}
                    </Text>
                    <Text dimColor> ({item.shortcut})</Text>
                    {item.key === "errors" && metrics.failedExchanges > 0 && (
                      <Text color={theme.error}>
                        {" "}
                        {fmtNum(metrics.failedExchanges)}
                      </Text>
                    )}
                  </Text>
                ))}
              </Box>
            ))}

            {activeNav === "capabilities" && (
              <NavList
                items={routes}
                itemKey={(r) => r.id}
                label={(r) => r.id}
                dotColor={routeDot}
                emptyText="No capabilities"
                selectedIndex={routeScroll.selectedIndex}
                listOffset={routeScroll.scrollOffset}
                visibleRows={navListHeight}
                width={leftWidth - 6}
              />
            )}
            {activeNav === "agents" && (
              <NavList
                items={agents}
                itemKey={(a) => a.key}
                label={(a) => a.key}
                dotColor={agentDot}
                emptyText="No agents"
                selectedIndex={agentScroll.selectedIndex}
                listOffset={agentScroll.scrollOffset}
                visibleRows={navListHeight}
                width={leftWidth - 6}
              />
            )}
            {activeNav === "tools" && (
              <NavList
                items={tools}
                itemKey={(t) => t.name}
                label={(t) => t.name}
                dotColor={toolDot}
                emptyText="No tools"
                selectedIndex={toolScroll.selectedIndex}
                listOffset={toolScroll.scrollOffset}
                visibleRows={navListHeight}
                width={leftWidth - 6}
              />
            )}
          </Panel>
        </Box>

        {/* Center */}
        {center}

        {/* Right: metrics */}
        <Box flexDirection="column" width={rightWidth}>
          <Panel title="METRICS" width={rightWidth} flexGrow={1}>
            <DotGraph
              values={liveTraffic}
              columns={rightWidth - 4}
              steps={metricSteps(metricsGraphLevels)}
              label="Exchanges per 5s bucket"
            />
            <Text> </Text>
            <Text bold dimColor>
              THROUGHPUT
            </Text>
            {(
              [
                ["Exchanges", fmtNum(metrics.totalExchanges), theme.accent],
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
                ["Capabilities", fmtNum(metrics.totalRoutes), ""],
              ] as [string, string, string][]
            ).map(([label, value, color]) => (
              <Box key={label}>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{label}:</Text>
                </Box>
                <Text bold {...(color ? { color } : {})}>
                  {value}
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text bold dimColor>
              LATENCY (5m)
            </Text>
            {(
              [
                ["Avg", formatDuration(metrics.avgDurationMs), ""],
                ["p90", formatDuration(metrics.p90DurationMs), ""],
                ["p95", formatDuration(metrics.p95DurationMs), ""],
                ["p99", formatDuration(metrics.p99DurationMs), ""],
              ] as [string, string, string][]
            ).map(([label, value, color]) => (
              <Box key={label}>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{label}:</Text>
                </Box>
                <Text bold {...(color ? { color } : {})}>
                  {value}
                </Text>
              </Box>
            ))}
          </Panel>
        </Box>
      </Box>

      {/* Footer: filter/follow state + contextual key hints */}
      <Box paddingX={1} width={width}>
        <Text wrap="truncate">
          {(filterTyping || filter !== "") && (
            <Text color={theme.accent}>
              /{filter}
              {filterTyping ? "▏" : ""}
              {"  "}
            </Text>
          )}
          {follow && <Text color={theme.success}>● follow{"  "}</Text>}
          {keymapItems.map((item, i) => (
            <Text key={item.key}>
              {i > 0 && <Text>{"   "}</Text>}
              <Text color={theme.accentSoft}>{item.key}</Text>
              <Text dimColor> {item.action}</Text>
            </Text>
          ))}
        </Text>
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
