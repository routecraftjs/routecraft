import { Box, Text } from "ink";
import type { ExchangeRecord, ExchangeSnapshot } from "../types.js";
import { statusColor, formatDuration, truncate } from "../utils.js";
import { theme } from "../theme.js";
import { Panel } from "./panel.js";
import { formatJson, ColoredJsonLine } from "./json-format.js";

/**
 * Build the scrollable lines for the deep view: headers + body sections.
 */
function buildSnapshotLines(
  snapshot: ExchangeSnapshot,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  lines.push("HEADERS");
  lines.push(...formatJson(snapshot.headers, maxWidth));
  lines.push("");
  lines.push("BODY");
  if (snapshot.body !== null) {
    lines.push(...formatJson(snapshot.body, maxWidth));
    if (snapshot.truncated) {
      lines.push("");
      lines.push("[Body truncated to configured limit]");
    }
  } else {
    lines.push("[null]");
  }

  return lines;
}

export function ExchangeDeepView({
  exchange,
  snapshot,
  width,
  height,
  scrollOffset,
  color = theme.accent,
}: {
  exchange: ExchangeRecord;
  snapshot: ExchangeSnapshot | null;
  width: number;
  height: number;
  scrollOffset: number;
  color?: string;
}) {
  // Header panel: border (2) + content (3 lines: capability + exchange + status)
  const headerHeight = 5;
  // JSON panel chrome: border (2) + title (1) + separator (1) + footer (1)
  const jsonChrome = 5;
  const jsonWidth = Math.max(width - 6, 20);
  const visibleRows = Math.max(height - headerHeight - jsonChrome, 3);

  const hasSnapshot = snapshot !== null;
  const jsonLines = hasSnapshot
    ? buildSnapshotLines(snapshot, jsonWidth)
    : [
        "[Snapshots not captured]",
        "",
        "Enable with:",
        "  telemetry({ sqlite: { captureSnapshots: true } })",
      ];

  // Clamp so overscrolling past the last line cannot blank the panel or
  // report an out-of-range line window.
  const offset = Math.max(
    0,
    Math.min(scrollOffset, Math.max(jsonLines.length - visibleRows, 0)),
  );
  const visible = jsonLines.slice(offset, offset + visibleRows);

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
        </Text>
      </Panel>

      <Panel
        title="EXCHANGE SNAPSHOT"
        subtitle={
          <Text dimColor>
            ({offset + 1}-{Math.min(offset + visibleRows, jsonLines.length)}/
            {jsonLines.length} lines)
          </Text>
        }
        width={width}
        flexGrow={1}
        color={color}
      >
        {visible.map((line, i) => {
          if (line === "HEADERS" || line === "BODY") {
            return (
              <Text key={offset + i} bold color={theme.accent}>
                {line}
              </Text>
            );
          }
          if (line.startsWith("[")) {
            return (
              <Text key={offset + i} dimColor>
                {line}
              </Text>
            );
          }
          return <ColoredJsonLine key={offset + i} line={line} />;
        })}
        {visible.length < visibleRows &&
          Array.from({ length: visibleRows - visible.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
      </Panel>
    </Box>
  );
}
