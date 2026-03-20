import { Fragment, type ReactNode } from "react";
import { Box, Text } from "ink";
import { col } from "../utils.js";

export interface ColumnDef<T> {
  /** Header label */
  header: string;
  /** Fixed character width, or "flex" to fill remaining space */
  width: number | "flex";
  /** Text alignment. Default: "left" */
  align?: "left" | "right";
  /** Render cell content. Receives row data, selection state, and resolved column width. */
  render: (row: T, selected: boolean, colWidth: number) => ReactNode;
}

export interface TableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  /** Unique key for each row */
  rowKey: (row: T, index: number) => string;
  /** Selected row index in full data array, or -1/undefined for no selection */
  selectedIndex?: number;
  /** First visible row (scroll offset) */
  scrollOffset: number;
  /** Number of visible rows */
  visibleRows: number;
  /** Gap between columns in characters. Default: 2 */
  gap?: number;
  /** Message when data is empty */
  emptyMessage?: string;
  /**
   * Optional full-row override for special rows (e.g., group headers).
   * Return undefined to use normal column rendering.
   */
  renderFullRow?: (row: T, index: number) => ReactNode | undefined;
}

export function Table<T>({
  columns,
  data,
  rowKey,
  selectedIndex,
  scrollOffset,
  visibleRows,
  gap = 2,
  emptyMessage = "No data",
  renderFullRow,
}: TableProps<T>) {
  const gapStr = " ".repeat(gap);

  // Header
  const header = (
    <Box>
      {columns.map((c, ci) => {
        const isLast = ci === columns.length - 1;
        const after = isLast ? "" : gapStr;

        if (c.width === "flex") {
          return (
            <Fragment key={ci}>
              <Box flexGrow={1}>
                <Text bold dimColor>
                  {c.header}
                </Text>
              </Box>
              {after && <Text>{after}</Text>}
            </Fragment>
          );
        }

        const text =
          c.align === "right"
            ? c.header.padStart(c.width)
            : col(c.header, c.width);

        return (
          <Fragment key={ci}>
            <Text bold dimColor>
              {text}
            </Text>
            {after && <Text>{after}</Text>}
          </Fragment>
        );
      })}
    </Box>
  );

  if (data.length === 0) {
    return (
      <>
        {header}
        <Text dimColor>{emptyMessage}</Text>
      </>
    );
  }

  const visible = data.slice(scrollOffset, scrollOffset + visibleRows);
  const remaining = data.length - scrollOffset - visibleRows;

  return (
    <>
      {header}
      {visible.map((row, vi) => {
        const dataIndex = scrollOffset + vi;
        const selected = dataIndex === selectedIndex;

        // Full-row override (e.g., group headers)
        const fullRow = renderFullRow?.(row, dataIndex);
        if (fullRow !== undefined) {
          return <Box key={rowKey(row, dataIndex)}>{fullRow}</Box>;
        }

        return (
          <Box key={rowKey(row, dataIndex)}>
            {columns.map((c, ci) => {
              const isLast = ci === columns.length - 1;
              const after = isLast ? "" : gapStr;
              const resolved = c.width === "flex" ? 0 : c.width;
              const cell = c.render(row, selected, resolved);

              if (c.width === "flex") {
                return (
                  <Fragment key={ci}>
                    <Box flexGrow={1}>
                      <Text wrap="truncate">{cell}</Text>
                    </Box>
                    {after && <Text>{after}</Text>}
                  </Fragment>
                );
              }

              return (
                <Fragment key={ci}>
                  {cell}
                  {after && <Text>{after}</Text>}
                </Fragment>
              );
            })}
          </Box>
        );
      })}
      <Text dimColor>{remaining > 0 ? "\u2193 more" : " "}</Text>
    </>
  );
}
