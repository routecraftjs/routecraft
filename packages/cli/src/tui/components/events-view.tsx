import { Box, Text } from "ink";
import type { EventRecord } from "../types.js";
import { col, truncate, formatDetails, scrollOffset } from "../utils.js";

export function EventsView({
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
