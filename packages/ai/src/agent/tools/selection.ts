import {
  ADAPTER_DIRECT_REGISTRY,
  rcError,
  sanitizeEndpoint,
  type CraftContext,
  type DirectRouteMetadata,
  type Tag,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ADAPTER_FN_REGISTRY } from "../../fn/store.ts";
import type { FnHandlerContext, FnOptions } from "../../fn/types.ts";
import { directTool } from "./builders.ts";
import { isDeferredFn, type FnEntry } from "./types.ts";

/**
 * Synchronous or async guard run after schema validation, before the
 * underlying handler. Throwing surfaces back to the LLM as a tool error
 * so the model can self-correct.
 *
 * @experimental
 */
export type ToolGuard = (
  input: unknown,
  ctx: FnHandlerContext,
) => void | Promise<void>;

/**
 * One entry in the agent's `tools([...])` list.
 *
 * - bare string: name lookup. Plain ids resolve against the fn registry;
 *   `direct_*` falls back to the direct registry via `directTool`.
 * - `{ name, guard?, description? }`: same lookup, with optional
 *   per-binding overrides. The `description` override applies only to
 *   THIS binding (the registry entry stays the source of truth, so
 *   other agents binding the same fn see the canonical description).
 *   Use this when an agent's calling context calls for a different
 *   framing of the tool than the registered description provides.
 * - `{ tagged, guard? }`: select every fn / route whose tags include any
 *   of the requested tag(s). Optional guard applies to every match.
 *   No description override here: applying one description to N
 *   matched tools is almost always wrong.
 *
 * @experimental
 */
export type ToolsItem =
  | string
  | { name: string; guard?: ToolGuard; description?: string }
  | { tagged: Tag | Tag[]; guard?: ToolGuard };

/**
 * Brand for {@link ToolSelection}. Lets the agent runtime detect a
 * `tools(...)` value vs a plain array.
 *
 * @internal
 */
export const TOOL_SELECTION_BRAND = Symbol.for("routecraft.ai.tools.selection");

/**
 * Opaque deferred descriptor returned by `tools(...)`. Resolves at
 * agent dispatch time, when both the fn registry and the direct route
 * registry are populated.
 *
 * @experimental
 */
export interface ToolSelection {
  readonly [TOOL_SELECTION_BRAND]: true;
  /**
   * Resolve the selection against the live context. Throws RC5003 on
   * any unresolvable explicit reference (unknown name, deferred
   * resolution failure). Tag selectors that match nothing contribute
   * zero tools and never throw.
   */
  readonly resolve: (ctx: CraftContext) => ResolvedTool[];
}

/**
 * A tool ready to be wired into the LLM tool list. Produced by
 * `ToolSelection.resolve()`.
 *
 * @experimental
 */
export interface ResolvedTool {
  /** Tool name presented to the LLM (matches the registered fn id or, for routes referenced by convention, `direct_<routeId>`). */
  name: string;
  /** Description shown to the LLM. */
  description: string;
  /** Standard Schema validating the LLM-supplied input. */
  input: StandardSchemaV1<unknown, unknown>;
  /** Optional tags inherited from the underlying registration. */
  tags?: Tag[];
  /** Optional guard run after validation, before the handler. */
  guard?: ToolGuard;
  /** The function the LLM ultimately invokes. */
  handler: FnOptions["handler"];
}

/**
 * Type guard. Returns true when `value` is a tool selection produced
 * by `tools(...)`.
 *
 * @internal
 */
export function isToolSelection(value: unknown): value is ToolSelection {
  return (
    typeof value === "object" &&
    value !== null &&
    TOOL_SELECTION_BRAND in value &&
    (value as { [TOOL_SELECTION_BRAND]: unknown })[TOOL_SELECTION_BRAND] ===
      true
  );
}

/**
 * Build a tool selection for an agent from a flat list of references.
 *
 * Items can be bare strings, `{ name, guard? }`, or `{ tagged, guard? }`.
 * Resolution happens lazily at agent dispatch time.
 *
 * Resolution rules:
 * - Bare names look up exact matches in the fn registry first; if
 *   missing AND the name starts with `direct_`, the suffix is treated
 *   as a direct route id and wrapped via `directTool`. Names starting
 *   with `agent_` or `mcp_` produce a "not yet supported" error
 *   (stories E and F).
 * - Tag selectors walk both the fn registry and the direct route
 *   registry, including any entry whose tags overlap with the
 *   requested set. Direct routes not already covered by a fn registry
 *   entry are surfaced under the `direct_<routeId>` name.
 * - Final list is deduplicated by tool name. Explicit references win
 *   over tag-selector matches regardless of position in the list.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agent({
 *   tools: tools([
 *     "currentTime",
 *     "fetchOrder",
 *     "direct_cancel-order",
 *     { name: "sendSlack", guard: confirmGuard },
 *     { tagged: "read-only" },
 *   ]),
 * });
 * ```
 */
export function tools(items: ToolsItem[]): ToolSelection {
  if (!Array.isArray(items)) {
    throw rcError("RC5003", undefined, {
      message: `tools(items): items must be an array.`,
    });
  }
  return {
    [TOOL_SELECTION_BRAND]: true,
    resolve(ctx) {
      const explicit = new Map<string, ResolvedTool>();

      // Phase 1: explicit refs (bare strings + { name, guard }).
      for (const item of items) {
        if (typeof item === "string") {
          const tool = resolveByName(ctx, item, undefined);
          explicit.set(tool.name, tool);
          continue;
        }
        if (item === null || typeof item !== "object") {
          throw rcError("RC5003", undefined, {
            message: `tools(): each item must be a string, { name, guard?, description? }, or { tagged, guard? }.`,
          });
        }
        if ("name" in item) {
          if (typeof item.name !== "string" || item.name.trim() === "") {
            throw rcError("RC5003", undefined, {
              message: `tools(): { name } must be a non-empty string.`,
            });
          }
          if (
            item.description !== undefined &&
            (typeof item.description !== "string" ||
              item.description.trim() === "")
          ) {
            throw rcError("RC5003", undefined, {
              message: `tools(): { name: "${item.name}", description } must be a non-empty string when present.`,
            });
          }
          const base = resolveByName(ctx, item.name, item.guard);
          // Per-binding description override. The registry entry is
          // never mutated, so other agents binding the same fn still
          // see the canonical description.
          const tool: ResolvedTool =
            item.description !== undefined
              ? { ...base, description: item.description }
              : base;
          explicit.set(tool.name, tool);
        } else if (!("tagged" in item)) {
          throw rcError("RC5003", undefined, {
            message: `tools(): each object item must include "name" or "tagged".`,
          });
        }
      }

      // Phase 2: tag selectors. Explicit names already in the map win.
      const out = new Map<string, ResolvedTool>(explicit);
      for (const item of items) {
        if (typeof item === "object" && item !== null && "tagged" in item) {
          const wanted = normalizeTags(item.tagged);
          if (wanted.length === 0) continue;
          for (const match of resolveByTags(ctx, wanted, item.guard)) {
            if (!out.has(match.name)) out.set(match.name, match);
          }
        }
      }

      return [...out.values()];
    },
  };
}

function resolveByName(
  ctx: CraftContext,
  name: string,
  guard: ToolGuard | undefined,
): ResolvedTool {
  if (typeof name !== "string" || name.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `tools(): tool name must be a non-empty string.`,
    });
  }
  const fnRegistry = ctx.getStore(ADAPTER_FN_REGISTRY) as
    | Map<string, FnEntry>
    | undefined;
  const fnEntry = fnRegistry?.get(name);
  if (fnEntry) {
    return resolveFnEntry(ctx, name, fnEntry, guard);
  }

  if (name.startsWith("agent_")) {
    throw rcError("RC5003", undefined, {
      message: `tools(): "${name}" looks like an agent reference. Sub-agent tools land in a follow-up story.`,
    });
  }
  if (name.startsWith("mcp_")) {
    throw rcError("RC5003", undefined, {
      message: `tools(): "${name}" looks like an MCP reference. MCP tools land in a follow-up story.`,
    });
  }
  if (name.startsWith("direct_")) {
    const routeId = name.slice("direct_".length);
    if (routeId === "") {
      throw rcError("RC5003", undefined, {
        message: `tools(): "${name}" has an empty direct route id.`,
      });
    }
    const wrapper = directTool(routeId);
    const fn = wrapper.resolve(ctx, name);
    return toResolvedTool(name, fn, guard);
  }

  const known = listKnownNames(ctx);
  throw rcError("RC5003", undefined, {
    message:
      `tools(): unknown tool "${name}". ` +
      (known.length > 0
        ? `Available: ${known.join(", ")}.`
        : `No fns or direct routes are registered in this context.`),
  });
}

function resolveFnEntry(
  ctx: CraftContext,
  name: string,
  entry: FnEntry,
  guard: ToolGuard | undefined,
): ResolvedTool {
  if (isDeferredFn(entry)) {
    const fn = entry.resolve(ctx, name);
    return toResolvedTool(name, fn, guard);
  }
  return toResolvedTool(name, entry, guard);
}

function toResolvedTool(
  name: string,
  fn: FnOptions,
  guard: ToolGuard | undefined,
): ResolvedTool {
  return {
    name,
    description: fn.description,
    input: fn.input as StandardSchemaV1<unknown, unknown>,
    ...(fn.tags && fn.tags.length > 0 ? { tags: fn.tags } : {}),
    ...(guard ? { guard } : {}),
    handler: fn.handler as FnOptions["handler"],
  };
}

function resolveByTags(
  ctx: CraftContext,
  wanted: Tag[],
  guard: ToolGuard | undefined,
): ResolvedTool[] {
  const wantedSet = new Set(wanted);
  const out: ResolvedTool[] = [];
  const seenNames = new Set<string>();
  // Track route ids already surfaced via a fn-registry directTool wrapper
  // **that actually contributed** so the direct-registry walk doesn't
  // double-include them. Wrappers that didn't match the wanted tag set
  // are NOT added here -- the underlying route may still match by its
  // own tags and is allowed to surface under the prefix convention.
  const coveredRouteIds = new Set<string>();

  // Walk the fn registry first so explicit fn-side tags (incl. directTool
  // wrappers) take precedence over a parallel direct-registry walk.
  // Skip non-direct deferred entries entirely: agentTool/mcpTool always
  // throw on .resolve() by design, and a misconfigured directTool would
  // throw too -- swallowing failures here would mask real config bugs,
  // so we don't resolve such entries unless an explicit by-name ref
  // forces it.
  const fnRegistry = ctx.getStore(ADAPTER_FN_REGISTRY) as
    | Map<string, FnEntry>
    | undefined;
  if (fnRegistry) {
    for (const [name, entry] of fnRegistry) {
      if (isDeferredFn(entry)) {
        if (entry.kind !== "direct") continue;
        // Use the wrapper's explicit `overrides.tags` when present so a
        // `directTool(routeId, { tags: [...] })` wrapper actually drives
        // selection. Fall back to peeking the underlying route's tags
        // when no override was supplied.
        const candidateTags =
          entry.overrideTags ?? peekDirectTags(ctx, entry.targetId);
        if (!candidateTags.some((t) => wantedSet.has(t))) continue;
        const fn = entry.resolve(ctx, name);
        out.push(toResolvedTool(name, fn, guard));
        seenNames.add(name);
        coveredRouteIds.add(entry.targetId);
        continue;
      }
      const tags = entry.tags ?? [];
      if (tags.some((t) => wantedSet.has(t))) {
        out.push(toResolvedTool(name, entry, guard));
        seenNames.add(name);
      }
    }
  }

  // Walk the direct registry for routes not already surfaced via a
  // fn-registry wrapper. Use the prefix-convention name `direct_<id>`.
  const directRegistry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;
  if (directRegistry) {
    for (const [routeId, meta] of directRegistry) {
      if (coveredRouteIds.has(routeId)) continue;
      const tags = meta.tags ?? [];
      if (!tags.some((t) => wantedSet.has(t))) continue;
      const conventionName = `direct_${routeId}`;
      if (seenNames.has(conventionName)) continue;
      // Only include if the route is fully tool-shaped (has description
      // and input schema). Routes that are missing those silently skip
      // tag-selector inclusion -- explicit refs would still throw.
      if (
        typeof meta.description !== "string" ||
        meta.description.trim() === ""
      ) {
        continue;
      }
      if (!meta.input?.body) continue;
      const wrapper = directTool(routeId);
      const fn = wrapper.resolve(ctx, conventionName);
      out.push(toResolvedTool(conventionName, fn, guard));
      seenNames.add(conventionName);
    }
  }

  return out;
}

function peekDirectTags(ctx: CraftContext, routeId: string): Tag[] {
  const directRegistry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;
  // Routes register under the sanitised endpoint; look up the same way.
  return directRegistry?.get(sanitizeEndpoint(routeId))?.tags ?? [];
}

function normalizeTags(value: Tag | Tag[]): Tag[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (t): t is Tag => typeof t === "string" && t.trim() !== "",
  );
}

function listKnownNames(ctx: CraftContext): string[] {
  const fnNames = [
    ...(
      (ctx.getStore(ADAPTER_FN_REGISTRY) as Map<string, FnEntry> | undefined) ??
      new Map()
    ).keys(),
  ];
  const routeNames = [
    ...(
      (ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
        | Map<string, DirectRouteMetadata>
        | undefined) ?? new Map()
    ).keys(),
  ].map((id) => `direct_${id}`);
  return [...fnNames, ...routeNames].sort();
}
