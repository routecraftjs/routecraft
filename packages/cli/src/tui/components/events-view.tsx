import { Text } from "ink";
import type { EventRecord } from "../types.js";
import { col } from "../utils.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { theme, selectedProps } from "../theme.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn, eventDetailColumns } from "./event-columns.js";

/**
 * Width-aware column set: narrow panes shed the Adapter and Exchange
 * detail columns so the flex event name keeps a useful width.
 */
function buildEventColumns(innerWidth: number): ColumnDef<EventRecord>[] {
  return [
    selectorColumn<EventRecord>(),
    {
      // Date is omitted: the stream is recent by construction and the
      // full date starved the flex event-name column at common widths.
      header: "Time",
      width: 8,
      render: (row, selected, w) => (
        <Text {...selectedProps(selected)}>
          {col(row.timestamp.replace("T", " ").slice(11, 19), w)}
        </Text>
      ),
    },
    {
      header: "Event",
      width: "flex",
      render: (row) => <Text>{row.eventName}</Text>,
    },
    ...eventDetailColumns<EventRecord>((row) => row, {
      adapter: innerWidth >= 80,
      exchange: innerWidth >= 68,
    }),
  ];
}

export function EventsView({
  events,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color = theme.muted,
}: {
  events: EventRecord[];
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
  color?: string;
}) {
  const tableRows = Math.max(height - PANEL_TABLE_CHROME, 5);

  return (
    <Panel
      title="EVENTS"
      subtitle={<Text dimColor>({events.length} total)</Text>}
      width={width}
      flexGrow={1}
      color={color}
    >
      <Table
        columns={buildEventColumns(width - 4)}
        data={events}
        rowKey={(ev, i) =>
          ev.id !== undefined ? String(ev.id) : `${ev.timestamp}-${i}`
        }
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        visibleRows={tableRows}
        emptyMessage="No events recorded yet."
      />
    </Panel>
  );
}
