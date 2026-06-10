import { Box, Text } from "ink";
import type { ExchangeRecord, AgentRunInfo, ToolCallRow } from "../types.js";
import { statusColor, formatDuration, col, toolStatusColor } from "../utils.js";
import { theme, selectedProps } from "../theme.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn } from "./event-columns.js";

const toolCallColumns: ColumnDef<ToolCallRow>[] = [
  selectorColumn<ToolCallRow>(),
  {
    header: "Tool",
    width: "flex",
    render: (row, selected) => (
      <Text {...selectedProps(selected)}>{row.toolName}</Text>
    ),
  },
  {
    header: "Status",
    width: 8,
    render: (row, _sel, w) => (
      <Text color={toolStatusColor(row.status)}>{col(row.status, w)}</Text>
    ),
  },
  {
    header: "I/O",
    width: 3,
    render: (row) => (
      <Text dimColor>
        {(row.hasInput ? "i" : "-") + (row.hasOutput ? "o" : "-")}
      </Text>
    ),
  },
  {
    header: "Duration",
    width: 8,
    align: "right",
    render: (row) => <Text>{formatDuration(row.durationMs).padStart(8)}</Text>,
  },
];

/**
 * Detail view for a single agent run (one dispatching exchange): model,
 * token usage and finish reason, plus the ordered tool-call timeline. The
 * tool input/output themselves open in {@link ToolCallDetail}.
 */
export function AgentRunDetail({
  agentKey,
  run,
  info,
  toolCalls,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color = theme.accent,
}: {
  agentKey: string;
  run: ExchangeRecord;
  info: AgentRunInfo | null;
  toolCalls: ToolCallRow[];
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
  color?: string;
}) {
  // Header panel: border (2) + 4 content lines.
  const headerHeight = 6;
  const tableRows = Math.max(height - headerHeight - PANEL_TABLE_CHROME, 3);

  const tokens =
    info && (info.inputTokens !== null || info.outputTokens !== null)
      ? `${info.inputTokens ?? "?"} in / ${info.outputTokens ?? "?"} out` +
        (info.totalTokens !== null ? ` (${info.totalTokens} total)` : "")
      : info && info.totalTokens !== null
        ? `${info.totalTokens} total`
        : "-";

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel width={width}>
        <Text>
          Agent:{" "}
          <Text bold color={theme.accent}>
            {agentKey}
          </Text>
        </Text>
        <Text>
          Model: <Text bold>{info?.model ?? "-"}</Text>
        </Text>
        <Text>
          Status:{" "}
          <Text bold color={statusColor(info?.status ?? run.status)}>
            {info?.status ?? run.status}
          </Text>
          {info?.finishReason && (
            <Text>
              {"  "}Finish: <Text bold>{info.finishReason}</Text>
            </Text>
          )}
        </Text>
        <Text>
          Tokens: <Text bold>{tokens}</Text>
        </Text>
      </Panel>

      <Panel title="TOOL CALLS" width={width} flexGrow={1} color={color}>
        <Table
          columns={toolCallColumns}
          data={toolCalls}
          rowKey={(c) => c.toolCallId}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          visibleRows={tableRows}
          emptyMessage="No tool calls"
        />
      </Panel>
    </Box>
  );
}
