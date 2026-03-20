import { Text } from "ink";
import type { RouteSummary } from "../types.js";
import { statusColor, fmtNum, formatDuration } from "../utils.js";

export function RouteHeader({ route }: { route: RouteSummary }) {
  return (
    <>
      <Text>
        Capability:{" "}
        <Text bold color="cyan">
          {route.id}
        </Text>
      </Text>
      <Text>
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
