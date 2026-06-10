import { Box, Text } from "ink";
import type { ExchangeRecord, EventRecord } from "../types.js";
import { statusColor, formatDuration, col, truncate } from "../utils.js";
import { DETAIL_INFO_CHROME } from "../layout.js";
import { theme } from "../theme.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn, eventDetailColumns } from "./event-columns.js";
import { parseDetails } from "./json-format.js";

type DisplayRow = {
  type: "header" | "event";
  text?: string;
  event?: EventRecord;
  indent: number;
};

/**
 * Group events by exchangeId to show parent/child flow.
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

const detailColumns: ColumnDef<DisplayRow>[] = [
  selectorColumn<DisplayRow>(),
  {
    header: "Time",
    width: 10,
    render: (row, _sel, w) => {
      if (!row.event) return <Text>{col("", w)}</Text>;
      const indent = " ".repeat(row.indent);
      // col() bounds indent + time to the column so an indented child
      // row cannot push the rest of the row into wrapping.
      return (
        <Text dimColor>
          {col(indent + row.event.timestamp.replace("T", " ").slice(11, 19), w)}
        </Text>
      );
    },
  },
  {
    header: "Event",
    width: "flex",
    render: (row) => {
      if (!row.event) return <Text />;
      return <Text>{row.event.eventName}</Text>;
    },
  },
  ...eventDetailColumns<DisplayRow>((row) => row.event),
];

export function CenterExchangeDetail({
  exchange,
  events,
  width,
  height,
  scrollOffset,
  selectedIndex = -1,
  color = theme.muted,
}: {
  exchange: ExchangeRecord;
  events: EventRecord[];
  width: number;
  height: number;
  scrollOffset: number;
  selectedIndex?: number;
  color?: string;
}) {
  const hasExtra = exchange.error ? 2 : 0;
  const eventRows = Math.max(height - DETAIL_INFO_CHROME - hasExtra, 3);

  const groups = groupEventsByExchange(events, exchange.id);
  const hasChildren = groups.length > 1;

  const displayRows: DisplayRow[] = [];
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

  const eventsTitle = hasChildren
    ? `EXCHANGE FLOW (${groups.length} exchanges, ${events.length} events)`
    : `RELATED EVENTS (${events.length})`;

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel width={width}>
        <Text>
          Capability:{" "}
          <Text bold color={theme.accent}>
            {exchange.routeId}
          </Text>
        </Text>
        <Text>
          Exchange:{" "}
          <Text bold color={theme.accent}>
            {truncate(exchange.id, width - 14)}
          </Text>
        </Text>
        <Text>
          Status:{" "}
          <Text bold color={statusColor(exchange.status)}>
            {exchange.status}
          </Text>
          {exchange.durationMs !== null && (
            <Text>
              {"  "}Duration:{" "}
              <Text bold>{formatDuration(exchange.durationMs)}</Text>
            </Text>
          )}
          {"  "}Started: <Text bold>{exchange.startedAt}</Text>
          {exchange.completedAt && (
            <Text>
              {"  "}Completed: <Text bold>{exchange.completedAt}</Text>
            </Text>
          )}
        </Text>
        {exchange.error && exchange.status === "failed" && (
          <>
            <Text> </Text>
            <Text color="red">Error: {exchange.error}</Text>
          </>
        )}
        {exchange.error && exchange.status === "dropped" && (
          <>
            <Text> </Text>
            <Text color="yellow">Reason: {exchange.error}</Text>
          </>
        )}
      </Panel>

      <Panel title={eventsTitle} width={width} flexGrow={1} color={color}>
        <Table
          columns={detailColumns}
          data={displayRows}
          rowKey={(row, i) =>
            row.type === "header"
              ? `h-${i}`
              : `${row.event?.id ?? row.event?.timestamp}-${i}`
          }
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          visibleRows={eventRows}
          emptyMessage="No related events found"
          renderFullRow={(row) =>
            row.type === "header" ? (
              <Text bold color={theme.accent}>
                {row.text}
              </Text>
            ) : undefined
          }
        />
      </Panel>
    </Box>
  );
}
