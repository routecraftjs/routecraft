import { Box, Text } from "ink";
import type { ToolCallRow } from "../types.js";
import { formatDuration, col } from "../utils.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn } from "./event-columns.js";

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

const callColumns: ColumnDef<ToolCallRow>[] = [
  selectorColumn<ToolCallRow>(),
  {
    header: "Route",
    width: "flex",
    render: (row, selected) => (
      <Text {...(selected ? { color: "cyan" as const } : {})} bold={selected}>
        {row.routeId || "-"}
      </Text>
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
    header: "Exchange",
    width: 12,
    render: (row, _sel, w) => (
      <Text dimColor>{col(row.exchangeId.slice(0, 8), w)}</Text>
    ),
  },
  {
    header: "Duration",
    width: 8,
    align: "right",
    render: (row) => <Text>{formatDuration(row.durationMs).padStart(8)}</Text>,
  },
  {
    header: "Time",
    width: 8,
    render: (row, _sel, w) => (
      <Text dimColor>{col(row.timestamp.slice(11, 19), w)}</Text>
    ),
  },
];

/**
 * Center view for the Tools tab: the invocation history for one tool.
 */
export function ToolCallList({
  toolName,
  calls,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color = "gray",
}: {
  toolName: string;
  calls: ToolCallRow[];
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
  color?: string;
}) {
  const tableRows = Math.max(height - PANEL_TABLE_CHROME, 3);
  const title = toolName ? `TOOL CALLS: ${toolName}` : "TOOL CALLS";

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel title={title} width={width} flexGrow={1} color={color}>
        <Table
          columns={callColumns}
          data={calls}
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
