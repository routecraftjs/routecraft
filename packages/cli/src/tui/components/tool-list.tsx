import { Text } from "ink";
import type { ToolSummary } from "../types.js";
import { truncate } from "../utils.js";

function dotColor(tool: ToolSummary): string {
  if (tool.errorCount > 0) return "red";
  if (tool.callCount > 0) return "green";
  // Registered but not yet called.
  return "yellow";
}

/**
 * Left-nav list of tools (mirrors {@link CapabilityList}). Tools come from
 * `agent:tool:registered` events and from observed tool invocations.
 */
export function ToolList({
  tools,
  selectedIndex,
  listOffset,
  visibleRows,
  width,
}: {
  tools: ToolSummary[];
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
      {tools.length === 0 ? (
        <Text dimColor>No tools</Text>
      ) : (
        tools.slice(offset, offset + visibleRows).map((tool, vi) => {
          const i = offset + vi;
          return (
            <Text key={tool.name} wrap="truncate">
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? "> " : "  "}
              </Text>
              <Text color={dotColor(tool)}>{"● "}</Text>
              <Text
                {...(i === selectedIndex ? { color: "cyan" as const } : {})}
                bold={i === selectedIndex}
              >
                {truncate(tool.name, width - 2)}
              </Text>
            </Text>
          );
        })
      )}
      {tools.length > visibleRows && (
        <Text dimColor>
          {selectedIndex + 1}/{tools.length}
        </Text>
      )}
    </>
  );
}
