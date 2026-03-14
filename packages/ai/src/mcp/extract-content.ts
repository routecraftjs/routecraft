/**
 * Extract content from an MCP tool response.
 *
 * - Single text item: returns the string directly for convenience.
 * - Multiple items or non-text items: returns the full content array so
 *   callers can inspect type/text/data on each entry.
 * - No content: returns the raw response object.
 */
export function extractContent(
  response: {
    content?: Array<{ type: string; text?: string; data?: string }>;
  } | null,
): unknown {
  const content = response?.content;
  if (!Array.isArray(content) || content.length === 0) return response;

  // Single text entry: return the string for backward compatibility
  if (content.length === 1) {
    const item = content[0];
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (typeof item.data === "string") return item.data;
  }

  // Multiple items or non-text: return the full array
  return content;
}
