import { Box, Text } from "ink";
import type { ExchangeRecord } from "../types.js";
import {
  statusColor,
  formatDuration,
  col,
  truncate,
  scrollOffset,
} from "../utils.js";

export function CenterExchangeList({
  capabilityId,
  exchanges,
  selectedIndex,
  centerWidth,
  bodyHeight,
}: {
  capabilityId: string;
  exchanges: ExchangeRecord[];
  selectedIndex: number;
  centerWidth: number;
  bodyHeight: number;
}) {
  const idColWidth = Math.max(centerWidth - 50, 8);
  const tableRows = Math.max(bodyHeight - 6, 3);
  const offset = scrollOffset(selectedIndex, exchanges.length, tableRows);

  return (
    <Box
      flexDirection="column"
      width={centerWidth}
      flexGrow={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>
        EXCHANGES: <Text color="cyan">{capabilityId}</Text>
      </Text>
      <Text dimColor>{"\u2500".repeat(Math.max(centerWidth - 4, 20))}</Text>
      <Text bold dimColor>
        {"  "}
        {col("ID", idColWidth)}
        {"  "}
        {col("Status", 9)}
        {"  "}
        {"Duration".padStart(8)}
        {"  "}
        {"Time"}
      </Text>
      {exchanges.length === 0 ? (
        <Text dimColor>No exchanges</Text>
      ) : (
        exchanges.slice(offset, offset + tableRows).map((ex, vi) => {
          const i = offset + vi;
          return (
            <Text key={ex.id + ex.contextId} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
                {col(truncate(ex.id, idColWidth), idColWidth)}
              </Text>
              {"  "}
              <Text color={statusColor(ex.status)}>{col(ex.status, 9)}</Text>
              {"  "}
              <Text>{formatDuration(ex.durationMs).padStart(8)}</Text>
              {"  "}
              <Text dimColor>
                {ex.startedAt.replace("T", " ").slice(11, 19)}
              </Text>
            </Text>
          );
        })
      )}
      {exchanges.length > tableRows && (
        <Text dimColor>
          {offset + tableRows < exchanges.length ? "\u2193 " : "  "}
          {exchanges.length} total
        </Text>
      )}
    </Box>
  );
}
