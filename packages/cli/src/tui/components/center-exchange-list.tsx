import { Box, Text } from "ink";
import type { ExchangeRecord, RouteSummary, RouteActivity } from "../types.js";
import { statusColor, formatDuration, col } from "../utils.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { Panel } from "./panel.js";
import { RouteHeader } from "./route-header.js";
import { DotGraph, DEFAULT_STEPS } from "./dot-graph.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn } from "./event-columns.js";

const exchangeColumns: ColumnDef<ExchangeRecord>[] = [
  selectorColumn<ExchangeRecord>(),
  {
    header: "ID",
    width: "flex",
    render: (row, selected) => (
      <Text {...(selected ? { color: "cyan" as const } : {})} bold={selected}>
        {row.id}
      </Text>
    ),
  },
  {
    header: "Status",
    width: 9,
    render: (row, _sel, w) => (
      <Text color={statusColor(row.status)}>{col(row.status, w)}</Text>
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
      <Text dimColor>
        {col(row.startedAt.replace("T", " ").slice(11, 19), w)}
      </Text>
    ),
  },
];

export function CenterExchangeList({
  capabilityId,
  route,
  exchanges,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color = "gray",
  activity,
}: {
  capabilityId: string;
  route?: RouteSummary;
  exchanges: ExchangeRecord[];
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
  color?: string;
  activity?: RouteActivity | undefined;
}) {
  const graphTermRows = Math.ceil((DEFAULT_STEPS.length - 1) / 4);
  const headerRows = route ? 2 + graphTermRows + 2 : 0;
  const tableRows = Math.max(height - PANEL_TABLE_CHROME - headerRows, 3);

  const title = route ? "EXCHANGES" : `EXCHANGES: ${capabilityId}`;

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      {route && (
        <Panel width={width}>
          <RouteHeader route={route} />
          <Text> </Text>
          <DotGraph
            values={activity ? activity.throughput : []}
            columns={width - 4}
            label="Exchanges per 5s bucket"
          />
        </Panel>
      )}
      <Panel title={title} width={width} flexGrow={1} color={color}>
        <Table
          columns={exchangeColumns}
          data={exchanges}
          rowKey={(ex) => ex.id + ex.contextId}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          visibleRows={tableRows}
          emptyMessage="No exchanges"
        />
      </Panel>
    </Box>
  );
}
