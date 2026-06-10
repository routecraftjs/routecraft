import { Box, Text } from "ink";
import type { ExchangeRecord, AgentRunInfo } from "../types.js";
import { statusColor, formatDuration, col, fmtTokens } from "../utils.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { selectedProps } from "../theme.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn } from "./event-columns.js";

/**
 * Center view for the Agents tab: the agent's runs with the per-run
 * model and token usage surfaced at list level, so a run does not have
 * to be opened just to see what it cost. Run id and model share the
 * flexible space; the Time column only appears when the pane is wide
 * enough to keep single-line rows.
 */
export function AgentRunList({
  agentKey,
  runs,
  infos,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color,
}: {
  agentKey: string;
  runs: ExchangeRecord[];
  infos: Map<string, AgentRunInfo>;
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
  color?: string;
}) {
  const tableRows = Math.max(height - PANEL_TABLE_CHROME, 3);
  const title = agentKey ? `RUNS: ${agentKey}` : "RUNS";
  // Panel chrome is 4 (borders + padding); fixed columns + gaps consume
  // ~35, so reserve the Time column for panes that leave the two flex
  // columns at least ~10 characters each.
  const showTime = width - 4 >= 66;

  const columns: ColumnDef<ExchangeRecord>[] = [
    selectorColumn<ExchangeRecord>(),
    {
      header: "Run",
      width: "flex",
      render: (row, selected) => (
        <Text {...selectedProps(selected)}>{row.id}</Text>
      ),
    },
    {
      header: "Status",
      width: 9,
      render: (row, _sel, w) => {
        const status = infos.get(row.id)?.status ?? row.status;
        return <Text color={statusColor(status)}>{col(status, w)}</Text>;
      },
    },
    {
      header: "Model",
      width: "flex",
      render: (row) => <Text dimColor>{infos.get(row.id)?.model ?? "-"}</Text>,
    },
    {
      header: "Tokens",
      width: 6,
      align: "right",
      render: (row) => {
        const total = infos.get(row.id)?.totalTokens;
        return (
          <Text>
            {(total !== null && total !== undefined
              ? fmtTokens(total)
              : "-"
            ).padStart(6)}
          </Text>
        );
      },
    },
    {
      header: "Duration",
      width: 8,
      align: "right",
      render: (row) => (
        <Text>{formatDuration(row.durationMs).padStart(8)}</Text>
      ),
    },
    ...(showTime
      ? [
          {
            header: "Time",
            width: 8,
            render: (row, _sel, w) => (
              <Text dimColor>
                {col(row.startedAt.replace("T", " ").slice(11, 19), w)}
              </Text>
            ),
          } satisfies ColumnDef<ExchangeRecord>,
        ]
      : []),
  ];

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Panel
        title={title}
        width={width}
        flexGrow={1}
        {...(color ? { color } : {})}
      >
        <Table
          columns={columns}
          data={runs}
          rowKey={(ex) => `${ex.id}:${ex.contextId}`}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          visibleRows={tableRows}
          emptyMessage="No runs"
        />
      </Panel>
    </Box>
  );
}
