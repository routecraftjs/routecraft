import { Text } from "ink";
import type { AgentSummary } from "../types.js";
import { truncate } from "../utils.js";

function dotColor(agent: AgentSummary): string {
  if (agent.errorCount > 0) return "red";
  if (agent.runCount > 0) return "green";
  // Registered but not yet run.
  return "yellow";
}

/**
 * Left-nav list of agents (mirrors {@link CapabilityList}). By-name agents
 * are keyed by their registered id; inline agents by their route id.
 */
export function AgentList({
  agents,
  selectedIndex,
  listOffset,
  visibleRows,
  width,
}: {
  agents: AgentSummary[];
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
        {"─".repeat(width + 2)}
      </Text>
      {agents.length === 0 ? (
        <Text dimColor>No agents</Text>
      ) : (
        agents.slice(offset, offset + visibleRows).map((agent, vi) => {
          const i = offset + vi;
          return (
            <Text key={agent.key} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
              </Text>
              <Text color={dotColor(agent)}>{"● "}</Text>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {truncate(agent.key, width - 2)}
              </Text>
            </Text>
          );
        })
      )}
      {agents.length > visibleRows && (
        <Text dimColor>
          {selectedIndex + 1}/{agents.length}
        </Text>
      )}
    </>
  );
}
