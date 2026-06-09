import { Box, Text } from "ink";
import type { ToolCallRow } from "../types.js";
import { formatDuration, truncate } from "../utils.js";
import { Panel } from "./panel.js";
import { formatJson, ColoredJsonLine } from "./json-format.js";

function toolStatusColor(status: ToolCallRow["status"]): string {
  switch (status) {
    case "result":
      return "green";
    case "error":
      return "red";
    default:
      return "yellow";
  }
}

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
  color = "cyan",
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
  const visible = jsonLines.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel width={width}>
        <Text>
          Tool:{" "}
          <Text bold color="cyan">
            {truncate(call.toolName, width - 10)}
          </Text>
        </Text>
        <Text>
          Exchange:{" "}
          <Text bold color="cyan">
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
            ({scrollOffset + 1}-
            {Math.min(scrollOffset + visibleRows, jsonLines.length)}/
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
              <Text key={scrollOffset + i} bold color="yellow">
                {line}
              </Text>
            );
          }
          if (line.startsWith("[")) {
            return (
              <Text key={scrollOffset + i} dimColor>
                {line}
              </Text>
            );
          }
          return <ColoredJsonLine key={scrollOffset + i} line={line} />;
        })}
        {visible.length < visibleRows &&
          Array.from({ length: visibleRows - visible.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
      </Panel>
    </Box>
  );
}
