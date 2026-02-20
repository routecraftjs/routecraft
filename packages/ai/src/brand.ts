/**
 * Cross-instance identity for @routecraft/ai: Symbol.for() keys and type guards.
 * Shared across all copies of @routecraft/ai (and multiple routecraft versions) in a process.
 */

export const BRAND = {
  McpSourceAdapter: Symbol.for("routecraft.ai.McpSourceAdapter"),
  McpClientAdapter: Symbol.for("routecraft.ai.McpClientAdapter"),
  MCPAdapter: Symbol.for("routecraft.ai.MCPAdapter"),
} as const;

function isBranded(obj: unknown, key: symbol): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<symbol, unknown>)[key] === true
  );
}

export function isMcpSourceAdapter(obj: unknown): boolean {
  return isBranded(obj, BRAND.McpSourceAdapter);
}

export function isMcpClientAdapter(obj: unknown): boolean {
  return isBranded(obj, BRAND.McpClientAdapter);
}

export function isMcpDirectAdapter(obj: unknown): boolean {
  return isBranded(obj, BRAND.MCPAdapter);
}

export function isMcpAdapter(obj: unknown): boolean {
  return (
    isMcpSourceAdapter(obj) ||
    isMcpClientAdapter(obj) ||
    isMcpDirectAdapter(obj)
  );
}
