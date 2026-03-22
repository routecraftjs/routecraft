import { Text } from "ink";
import type { EventRecord } from "../types.js";
import { col, formatDetailColumns, type DetailColumns } from "../utils.js";
import type { ColumnDef } from "./table.js";

/**
 * Build the 4 standard event detail columns (Step, Adapter, Exchange, Duration).
 *
 * The accessor extracts an EventRecord from whatever row type T the table uses.
 * Returns undefined when the row has no event data (e.g., group headers).
 *
 * JSON is parsed once per row and shared across all 4 columns via a WeakMap cache.
 */
export function eventDetailColumns<T>(
  accessor: (row: T) => EventRecord | undefined,
): ColumnDef<T>[] {
  const cache = new WeakMap<EventRecord, DetailColumns>();

  function getColumns(row: T): DetailColumns | undefined {
    const ev = accessor(row);
    if (!ev) return undefined;
    let cols = cache.get(ev);
    if (!cols) {
      cols = formatDetailColumns(ev.eventName, ev.details);
      cache.set(ev, cols);
    }
    return cols;
  }

  return [
    {
      header: "Step",
      width: 10,
      render: (row, _sel, w) => {
        const cols = getColumns(row);
        if (!cols) return <Text>{col("", w)}</Text>;
        return <Text>{col(cols.step, w)}</Text>;
      },
    },
    {
      header: "Adapter",
      width: 10,
      render: (row, _sel, w) => {
        const cols = getColumns(row);
        if (!cols) return <Text>{col("", w)}</Text>;
        return <Text>{col(cols.adapter, w)}</Text>;
      },
    },
    {
      header: "Exchange",
      width: 12,
      render: (row, _sel, w) => {
        const cols = getColumns(row);
        if (!cols) return <Text>{col("", w)}</Text>;
        return <Text>{col(cols.exchange, w)}</Text>;
      },
    },
    {
      header: "Duration",
      width: 8,
      align: "right" as const,
      render: (row) => {
        const cols = getColumns(row);
        if (!cols) return <Text>{""}</Text>;
        return <Text>{cols.duration.padStart(8)}</Text>;
      },
    },
  ];
}

/**
 * Selector column that shows "> " for the selected row.
 */
export function selectorColumn<T>(): ColumnDef<T> {
  return {
    header: "",
    width: 2,
    render: (_row, selected) => (
      <Text {...(selected ? { color: "cyan" as const } : {})} bold={selected}>
        {selected ? "> " : "  "}
      </Text>
    ),
  };
}
