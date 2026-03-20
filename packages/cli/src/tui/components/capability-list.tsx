import { Text } from "ink";
import type { RouteSummary } from "../types.js";
import { truncate } from "../utils.js";

function dotColor(route: RouteSummary): string {
  if (route.failedExchanges > 0) return "red";
  if (route.totalExchanges > 0) return "green";
  return "yellow";
}

export function CapabilityList({
  routes,
  selectedIndex,
  listOffset,
  visibleRows,
  width,
}: {
  routes: RouteSummary[];
  selectedIndex: number;
  listOffset: number;
  visibleRows: number;
  width: number;
}) {
  const offset = listOffset;

  return (
    <>
      <Text> </Text>
      <Text bold dimColor>
        {"\u2500".repeat(width + 2)}
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
              </Text>
              <Text color={dotColor(route)}>{"\u25CF "}</Text>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {truncate(route.id, width - 2)}
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
