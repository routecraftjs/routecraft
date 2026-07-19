import type { KnownTag, Tag } from "@routecraft/routecraft";
import type { McpToolAnnotations } from "./types.ts";

/**
 * Merge a base set of annotation hints with per-key overrides. Override
 * values win per-key. Returns `undefined` when neither source contributes
 * anything, so callers omit `annotations` entirely rather than carrying an
 * empty object onto the `tools/list` wire. Shared by the `mcp()` source
 * adapter (tag-derived + explicit) and the proxy path (remote + config
 * overrides) so the merge policy lives once.
 *
 * @internal
 */
export function mergeAnnotations(
  base: McpToolAnnotations | undefined,
  overrides: McpToolAnnotations | undefined,
): McpToolAnnotations | undefined {
  const merged: McpToolAnnotations = { ...base, ...overrides };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The canonical correspondence between the well-known route tags and the MCP
 * tool annotation hints they describe. Both directions derive from this single
 * table, so the four pairs are declared once: `deriveAnnotationsFromTags`
 * (tag -> hint) and `deriveTagsFromAnnotations` (hint -> tag) stay exact
 * inverses, and adding a fifth correspondence is a one-line edit here rather
 * than two functions plus prose drifting apart.
 *
 * @internal
 */
export const TAG_ANNOTATION_HINTS = [
  ["read-only", "readOnlyHint"],
  ["destructive", "destructiveHint"],
  ["idempotent", "idempotentHint"],
  ["open-world", "openWorldHint"],
] as const satisfies ReadonlyArray<
  readonly [KnownTag, keyof McpToolAnnotations]
>;

/**
 * Derive the MCP tool annotation hints implied by a route's tags. Only the
 * well-known tags carry MCP meaning; any other tag is ignored here (it still
 * drives `tools()` selectors). Returns only the hints present as tags so the
 * result can merge under explicit annotations without clobbering unrelated
 * keys.
 *
 * @internal
 */
export function deriveAnnotationsFromTags(
  tags: readonly string[] | undefined,
): McpToolAnnotations {
  if (!tags || tags.length === 0) return {};
  const derived: McpToolAnnotations = {};
  for (const [tag, hint] of TAG_ANNOTATION_HINTS) {
    if (tags.includes(tag)) derived[hint] = true;
  }
  return derived;
}

/**
 * Derive capability tags from MCP `annotations` hints so MCP tools surface
 * alongside fns and direct routes under the same `Tag` shape (visible on
 * `ToolsCatalog.mcp[].tags` for the builder form of `tools()`, and on the
 * resolved tool's `tags` for downstream inspection). Returns an empty array
 * (omitted from the entry) when no hints apply.
 *
 * @internal
 */
export function deriveTagsFromAnnotations(
  annotations: McpToolAnnotations | undefined,
): Tag[] {
  if (!annotations) return [];
  const tags: Tag[] = [];
  for (const [tag, hint] of TAG_ANNOTATION_HINTS) {
    if (annotations[hint]) tags.push(tag);
  }
  return tags;
}
