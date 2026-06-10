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
  /** Render cell content. `colWidth` is the resolved width for fixed columns, undefined for flex. */
  render: (
    row: T,
    selected: boolean,
    colWidth: number | undefined,
  ) => ReactNode;
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
              {/* flexBasis 0 so the column takes the remaining space
                  rather than demanding its content width; otherwise long
                  content squeezes the fixed cells and wraps the row. */}
              <Box flexGrow={1} flexBasis={0} minWidth={0}>
                <Text bold dimColor wrap="truncate">
                  {c.header}
                </Text>
              </Box>
              {after && (
                <Box flexShrink={0}>
                  <Text>{after}</Text>
                </Box>
              )}
            </Fragment>
          );
        }

        const text =
          c.align === "right"
            ? c.header.padStart(c.width)
            : col(c.header, c.width);

        return (
          <Box key={ci} flexShrink={0}>
            <Text bold dimColor>
              {text}
            </Text>
            {after && <Text>{after}</Text>}
          </Box>
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
              const resolved = c.width === "flex" ? undefined : c.width;
              const cell = c.render(row, selected, resolved);

              if (c.width === "flex") {
                return (
                  <Fragment key={ci}>
                    {/* See the header note: flexBasis 0 keeps long flex
                        content from squeezing fixed cells into wrapping. */}
                    <Box flexGrow={1} flexBasis={0} minWidth={0}>
                      <Text wrap="truncate">{cell}</Text>
                    </Box>
                    {after && (
                      <Box flexShrink={0}>
                        <Text>{after}</Text>
                      </Box>
                    )}
                  </Fragment>
                );
              }

              return (
                <Box key={ci} flexShrink={0}>
                  {cell}
                  {after && <Text>{after}</Text>}
                </Box>
              );
            })}
          </Box>
        );
      })}
      <Text dimColor>{remaining > 0 ? "\u2193 more" : " "}</Text>
    </>
  );
}
