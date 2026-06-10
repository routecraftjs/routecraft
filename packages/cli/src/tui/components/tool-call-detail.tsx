import { Box, Text } from "ink";
import type { ToolCallRow } from "../types.js";
import { formatDuration, truncate, toolStatusColor } from "../utils.js";
import { theme } from "../theme.js";
import { Panel } from "./panel.js";
import { formatJson, ColoredJsonLine } from "./json-format.js";

/**
 * Build the scrollable lines for a tool call: input, output and error
 * sections. Sensitive payloads are only present when telemetry snapshot
 * capture was enabled at the time of the call.
 */
function buildLines(call: ToolCallRow, maxWidth: number): string[] {
  const lines: string[] = [];

  lines.push("INPUT");
  if (call.hasInput && call.input !== null) {
    lines.push(...formatJson(call.input, maxWidth));
  } else {
    lines.push("[Not captured - enable snapshots]");
  }
  lines.push("");
  lines.push("OUTPUT");
  if (call.status === "invoked") {
    lines.push("[Pending - tool still running or not recorded]");
  } else if (call.hasOutput && call.output !== null) {
    lines.push(...formatJson(call.output, maxWidth));
  } else if (call.status === "error") {
    lines.push("[No output - call errored]");
  } else {
    lines.push("[Not captured - enable snapshots]");
  }
  if (call.status === "error") {
    lines.push("");
    lines.push("ERROR");
    if (call.error !== null) {
      lines.push(...formatJson(call.error, maxWidth));
    } else {
      // Only the non-sensitive error class is persisted when snapshot
      // capture is off (the message can echo the tool input).
      lines.push(
        `[${call.errorName ?? "Error"} - enable snapshots for details]`,
      );
    }
  } else if (call.error !== null) {
    lines.push("");
    lines.push("ERROR");
    lines.push(...formatJson(call.error, maxWidth));
  }

  return lines;
}

/**
 * Scrollable detail view of one tool call's input/output/error, reusing
 * the JSON renderer from {@link ExchangeDeepView}.
 */
export function ToolCallDetail({
  call,
  width,
  height,
  scrollOffset,
  color = theme.accent,
}: {
  call: ToolCallRow;
  width: number;
  height: number;
  scrollOffset: number;
  color?: string;
}) {
  const headerHeight = 5;
  const jsonChrome = 5;
  const jsonWidth = Math.max(width - 6, 20);
  const visibleRows = Math.max(height - headerHeight - jsonChrome, 3);

  const jsonLines = buildLines(call, jsonWidth);
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
          Tool:{" "}
          <Text bold color={theme.accent}>
            {truncate(call.toolName, width - 10)}
          </Text>
        </Text>
        <Text>
          Exchange:{" "}
          <Text bold color={theme.accent}>
            {truncate(call.exchangeId, width - 14)}
          </Text>
        </Text>
        <Text>
          Status:{" "}
          <Text bold color={toolStatusColor(call.status)}>
            {call.status}
          </Text>
          {call.durationMs !== null && (
            <Text>
              {"  "}Duration:{" "}
              <Text bold>{formatDuration(call.durationMs)}</Text>
            </Text>
          )}
        </Text>
      </Panel>

      <Panel
        title="TOOL CALL"
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
          if (line === "INPUT" || line === "OUTPUT" || line === "ERROR") {
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
