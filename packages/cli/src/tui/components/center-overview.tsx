import { Box, Text } from "ink";
import type { RouteSummary, ExchangeRecord } from "../types.js";
import {
  statusColor,
  fmtNum,
  formatDuration,
  col,
  scrollOffset,
} from "../utils.js";

export function CenterOverview({
  route,
  recentExchanges,
  centerWidth,
  bodyHeight,
}: {
  route: RouteSummary | undefined;
  recentExchanges: ExchangeRecord[];
  centerWidth: number;
  bodyHeight: number;
}) {
  const recentRows = Math.max(bodyHeight - 10, 3);
  const offset = scrollOffset(0, recentExchanges.length, recentRows);

  return (
    <Box flexDirection="column" width={centerWidth} flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        {route ? (
          <>
            <Text bold>
              CAPABILITY: <Text color="cyan">{route.id}</Text>
            </Text>
            <Text>
              Status:{" "}
              <Text color={statusColor(route.status)}>{route.status}</Text>
              {"    "}Exchanges:{" "}
              <Text bold>{fmtNum(route.totalExchanges)}</Text>
              {"    "}Errors:{" "}
              <Text
                bold
                {...(route.failedExchanges > 0
                  ? { color: "red" as const }
                  : {})}
              >
                {fmtNum(route.failedExchanges)}
              </Text>
              {"    "}Dropped:{" "}
              <Text
                bold
                {...(route.droppedExchanges > 0
                  ? { color: "yellow" as const }
                  : {})}
              >
                {fmtNum(route.droppedExchanges)}
              </Text>
              {"    "}Avg:{" "}
              <Text bold>{formatDuration(route.avgDurationMs)}</Text>
            </Text>
          </>
        ) : (
          <Text dimColor>Select a capability to view details</Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexGrow={1}
      >
        <Text bold dimColor>
          RECENT EXCHANGES
        </Text>
        <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
        {(() => {
          const idColWidth = Math.max(centerWidth - 36, 12);
          return recentExchanges.length === 0 ? (
            <Text dimColor>No exchanges yet</Text>
          ) : (
            recentExchanges.slice(offset, offset + recentRows).map((ex) => (
              <Text key={ex.id + ex.contextId} wrap="truncate">
                <Text dimColor>{col(ex.id, idColWidth)}</Text>
                {"  "}
                <Text color={statusColor(ex.status)}>{col(ex.status, 9)}</Text>
                {"  "}
                <Text>{formatDuration(ex.durationMs).padStart(7)}</Text>
                {"  "}
                <Text dimColor>
                  {ex.startedAt.replace("T", " ").slice(11, 19)}
                </Text>
              </Text>
            ))
          );
        })()}
        {recentExchanges.length > recentRows && (
          <Text dimColor>
            {"\u2193"} {recentExchanges.length - recentRows} more
          </Text>
        )}
      </Box>
    </Box>
  );
}
