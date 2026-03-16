import { Box, Text } from "ink";
import type { ExchangeRecord, EventRecord } from "../types.js";
import {
  statusColor,
  formatDuration,
  formatDetails,
  col,
  truncate,
} from "../utils.js";

function parseDetails(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

export function CenterExchangeDetail({
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
