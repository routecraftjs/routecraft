import { Text } from "ink";
import { truncate } from "../utils.js";
import { selectedProps } from "../theme.js";

/**
 * Generic left-nav list used by the Capabilities, Agents and Tools tabs:
 * a status dot, a truncated label, a cursor on the selected row and a
 * position indicator when the list overflows the visible window.
 */
export function NavList<T>({
  items,
  itemKey,
  label,
  dotColor,
  emptyText,
  selectedIndex,
  listOffset,
  visibleRows,
  width,
}: {
  items: T[];
  itemKey: (item: T) => string;
  label: (item: T) => string;
  dotColor: (item: T) => string;
  emptyText: string;
  selectedIndex: number;
  listOffset: number;
  visibleRows: number;
  width: number;
}) {
  return (
    <>
      <Text> </Text>
      <Text bold dimColor>
        {"─".repeat(width + 2)}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>{emptyText}</Text>
      ) : (
        items.slice(listOffset, listOffset + visibleRows).map((item, vi) => {
          const i = listOffset + vi;
          const selected = i === selectedIndex;
          return (
            <Text key={itemKey(item)} wrap="truncate">
              <Text {...selectedProps(selected)}>{selected ? "> " : "  "}</Text>
              <Text color={dotColor(item)}>{"● "}</Text>
              <Text {...selectedProps(selected)}>
                {truncate(label(item), width - 2)}
              </Text>
            </Text>
          );
        })
      )}
      {items.length > visibleRows && (
        <Text dimColor>
          {selectedIndex + 1}/{items.length}
        </Text>
      )}
    </>
  );
}
