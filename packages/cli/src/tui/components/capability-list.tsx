import { Text } from "ink";
import type { RouteSummary } from "../types.js";
import { truncate, scrollOffset } from "../utils.js";

export function CapabilityList({
  routes,
  selectedIndex,
  visibleRows,
  colWidth,
}: {
  routes: RouteSummary[];
  selectedIndex: number;
  visibleRows: number;
  colWidth: number;
}) {
  const offset = scrollOffset(selectedIndex, routes.length, visibleRows);

  return (
    <>
      <Text> </Text>
      <Text bold dimColor>
        {"\u2500".repeat(colWidth + 2)}
      </Text>
      {routes.length === 0 ? (
        <Text dimColor>No capabilities</Text>
      ) : (
        routes.slice(offset, offset + visibleRows).map((route, vi) => {
          const i = offset + vi;
          return (
            <Text key={route.id} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {truncate(route.id, colWidth)}
              </Text>
            </Text>
          );
        })
      )}
      {routes.length > visibleRows && (
        <Text dimColor>
          {selectedIndex + 1}/{routes.length}
        </Text>
      )}
    </>
  );
}
