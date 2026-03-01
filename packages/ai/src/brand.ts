/**
 * Cross-instance identity for @routecraft/ai: Symbol.for() keys and type guards.
 * Shared across all copies of @routecraft/ai (and multiple routecraft versions) in a process.
 */

export const BRAND = {
  McpAdapter: Symbol.for("routecraft.ai.McpAdapter"),
} as const;

function isBranded(obj: unknown, key: symbol): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<symbol, unknown>)[key] === true
  );
}

export function isMcpAdapter(obj: unknown): boolean {
  return isBranded(obj, BRAND.McpAdapter);
}
