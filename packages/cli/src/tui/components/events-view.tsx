import { Text } from "ink";
import type { EventRecord } from "../types.js";
import { col } from "../utils.js";
import { PANEL_TABLE_CHROME } from "../layout.js";
import { Panel } from "./panel.js";
import { Table, type ColumnDef } from "./table.js";
import { selectorColumn, eventDetailColumns } from "./event-columns.js";

const eventColumns: ColumnDef<EventRecord>[] = [
  selectorColumn<EventRecord>(),
  {
    header: "Time",
    width: 19,
    render: (row, selected, w) => (
      <Text {...(selected ? { color: "cyan" as const } : {})} bold={selected}>
        {col(row.timestamp.replace("T", " ").slice(0, 19), w)}
      </Text>
    ),
  },
  {
    header: "Event",
    width: "flex",
    render: (row) => <Text color="cyan">{row.eventName}</Text>,
  },
  ...eventDetailColumns<EventRecord>((row) => row),
];

export function EventsView({
  events,
  selectedIndex,
  scrollOffset,
  width,
  height,
  color = "gray",
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
        columns={eventColumns}
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
