import { Text } from "ink";
import type { RouteSummary } from "../types.js";
import { statusColor, fmtNum, formatDuration } from "../utils.js";
import { theme } from "../theme.js";

export function RouteHeader({ route }: { route: RouteSummary }) {
  return (
    <>
      <Text wrap="truncate">
        Capability:{" "}
        <Text bold color={theme.accent}>
          {route.id}
        </Text>
      </Text>
      {/* One line, truncated: wrapping would push the capability line out
          of the fixed-height header panel on narrow terminals. */}
      <Text wrap="truncate">
        Status:{" "}
        <Text bold color={statusColor(route.status)}>
          {route.status}
        </Text>
        {"  "}Exchanges: <Text bold>{fmtNum(route.totalExchanges)}</Text>
        {"  "}Errors:{" "}
        <Text
          bold
          {...(route.failedExchanges > 0 ? { color: "red" as const } : {})}
        >
          {fmtNum(route.failedExchanges)}
        </Text>
        {"  "}Dropped:{" "}
        <Text
          bold
          {...(route.droppedExchanges > 0 ? { color: "yellow" as const } : {})}
        >
          {fmtNum(route.droppedExchanges)}
        </Text>
        {"  "}Avg: <Text bold>{formatDuration(route.avgDurationMs)}</Text>
      </Text>
    </>
  );
}
