import { Box, Text } from "ink";
import type { EventRecord } from "../types.js";
import { Panel } from "./panel.js";
import { formatJson, ColoredJsonLine, parseDetails } from "./json-format.js";

export function EventDetail({
  event,
  width,
  height,
  scrollOffset,
  color = "cyan",
}: {
  event: EventRecord;
  width: number;
  height: number;
  scrollOffset: number;
  color?: string;
}) {
  const d = parseDetails(event.details);
  const routeId =
    d && typeof d["routeId"] === "string" ? d["routeId"] : undefined;
  const exchangeId =
    d && typeof d["exchangeId"] === "string" ? d["exchangeId"] : undefined;

  // Header lines: context (always) + capability + exchange + event + time
  const headerLines = 1 + (routeId ? 1 : 0) + (exchangeId ? 1 : 0) + 2;
  // Top panel: border (2) + content lines
  const headerHeight = 2 + headerLines;
  // Bottom panel: border (2) + title/separator (2) + footer (1) = 5
  const jsonChrome = 5;
  const jsonWidth = Math.max(width - 6, 20);
  const jsonLines = formatJson(event.details, jsonWidth);
  const visibleRows = Math.max(height - headerHeight - jsonChrome, 3);
  const visible = jsonLines.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel width={width}>
        <Text>
          Context:{" "}
          <Text bold color="cyan">
            {event.contextId}
          </Text>
        </Text>
        {routeId && (
          <Text>
            Capability:{" "}
            <Text bold color="cyan">
              {routeId}
            </Text>
          </Text>
        )}
        {exchangeId && (
          <Text>
            Exchange:{" "}
            <Text bold color="cyan">
              {exchangeId}
            </Text>
          </Text>
        )}
        <Text>
          Event:{" "}
          <Text bold color="cyan">
            {event.eventName}
          </Text>
        </Text>
        <Text>
          Time:{" "}
          <Text bold>{event.timestamp.replace("T", " ").slice(0, 19)}</Text>
        </Text>
      </Panel>

      <Panel
        title="DETAILS"
        subtitle={
          <Text dimColor>
            ({scrollOffset + 1}-
            {Math.min(scrollOffset + visibleRows, jsonLines.length)}/
            {jsonLines.length} lines)
          </Text>
        }
        width={width}
        flexGrow={1}
        color={color}
      >
        {visible.map((line, i) => (
          <ColoredJsonLine key={scrollOffset + i} line={line} />
        ))}
        {visible.length < visibleRows &&
          Array.from({ length: visibleRows - visible.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
      </Panel>
    </Box>
  );
}
