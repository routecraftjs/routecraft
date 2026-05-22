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
import { dispatchMcpCall } from "../../mcp/dispatch.ts";
import {
  MCP_TOOL_REGISTRY,
  type McpToolRegistryEntry,
} from "../../mcp/types.ts";
import type { McpToolRegistry } from "../../mcp/tool-registry.ts";
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
 *   `Direct(<routeId>)` wraps a direct route via `directTool`;
 *   `MCP(server:tool)` / `MCP(server)` and the raw `mcp__server__tool`
 *   / `mcp__server` / `mcp__server__*` forms resolve against
 *   `MCP_TOOL_REGISTRY` (populated by `defineConfig.mcp` /
 *   `mcpPlugin({ clients })`).
 * - `{ name, guard?, description? }`: same lookup, with optional
 *   per-binding overrides. The `description` override applies only to
 *   THIS binding (the registry entry stays the source of truth, so
 *   other agents binding the same fn see the canonical description).
 *   Use this when an agent's calling context calls for a different
 *   framing of the tool than the registered description provides.
 *   For an MCP whole-server ref (`{ name: "MCP(server)", guard }`) the
 *   guard is attached to every expanded tool.
 * - `{ tagged, from?, guard? }`: select every fn / route / MCP tool
 *   whose tags include any of the requested tag(s) (OR semantics).
 *   `from?: string` restricts the selection to a single source:
 *   `from: "mcp__<server>"` matches only that server's MCP tools.
 *   Optional guard applies to every match.
 *
 * @experimental
 */
export type ToolsItem =
  | string
  | { name: string; guard?: ToolGuard; description?: string }
  | { tagged: Tag | Tag[]; from?: string; guard?: ToolGuard };

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
   * resolution failure) AND on tag selectors that match zero tools,
   * so a misconfigured selector cannot silently strip every tool from
   * an agent.
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
  /** Tool name presented to the LLM: the registered fn id, `direct_<routeId>` for routes, or `mcp__<server>__<tool>` for MCP tools. */
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
 * @experimental
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
 * - Bare names look up exact matches in the fn registry first.
 *   `Direct(<routeId>)` wraps a direct route via `directTool` (the
 *   LLM-facing tool name stays `direct_<routeId>`). `MCP(server:tool)`
 *   / `MCP(server)` and the raw `mcp__server__tool` / `mcp__server` /
 *   `mcp__server__*` forms resolve against `MCP_TOOL_REGISTRY`.
 * - Tag selectors walk the fn registry, the direct route registry,
 *   and the MCP tool registry, including any entry whose tags overlap
 *   with the requested set. `from?: string` narrows the walk: pass
 *   `from: "mcp__<server>"` to scope a tag selection to a single MCP
 *   server.
 * - Final list is deduplicated by tool name. Explicit references win
 *   over tag-selector matches regardless of position in the list.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agent({
 *   tools: tools([
 *     "CurrentTime",
 *     "fetchOrder",
 *     "Direct(cancel-order)",
 *     "MCP(github:create_issue)",
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
          // An exact fn id always wins over the MCP-ref grammar, so a fn
          // whose id happens to start with `mcp__` stays reachable.
          if (isMcpRefName(item) && !fnRegistryHas(ctx, item)) {
            for (const tool of resolveMcpRefs(ctx, item, undefined)) {
              explicit.set(tool.name, tool);
            }
            continue;
          }
          const tool = resolveByName(ctx, item, undefined);
          explicit.set(tool.name, tool);
          continue;
        }
        if (item === null || typeof item !== "object") {
          throw rcError("RC5003", undefined, {
            message: `tools(): each item must be a string, { name, guard?, description? }, or { tagged, from?, guard? }.`,
          });
        }
        if ("name" in item) {
          if (typeof item.name !== "string" || item.name.trim() === "") {
            throw rcError("RC5003", undefined, {
              message: `tools(): { name } must be a non-empty string.`,
            });
          }
          // MCP refs reject any description override (empty or not) so
          // users see the precise "MCP server is the source of truth"
          // message instead of the generic empty-string error.
          if (isMcpRefName(item.name) && !fnRegistryHas(ctx, item.name)) {
            if (item.description !== undefined) {
              throw rcError("RC5003", undefined, {
                message: `tools(): { name: "${item.name}", description } is not supported for MCP tools. The MCP server is the source of truth for description and schema; do not override.`,
              });
            }
            for (const tool of resolveMcpRefs(ctx, item.name, item.guard)) {
              explicit.set(tool.name, tool);
            }
            continue;
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
          const matches = resolveByTags(ctx, wanted, item.guard, item.from);
          if (matches.length === 0) {
            throw rcError("RC5003", undefined, {
              message: item.from
                ? `tools(): tagged selector matched no tools (tagged: ${formatTags(wanted)}, from: "${item.from}").`
                : `tools(): tagged selector matched no tools (tagged: ${formatTags(wanted)}).`,
            });
          }
          for (const match of matches) {
            if (!out.has(match.name)) out.set(match.name, match);
          }
        }
      }

      return [...out.values()];
    },
  };
}

/**
 * True when the fn registry holds an exact entry for `name`. Used to let
 * an explicitly registered fn win over the MCP-ref grammar for bare
 * strings (so a fn id starting with `mcp__` stays reachable).
 *
 * @internal
 */
function fnRegistryHas(ctx: CraftContext, name: string): boolean {
  const fnRegistry = ctx.getStore(ADAPTER_FN_REGISTRY) as
    | Map<string, FnEntry>
    | undefined;
  return fnRegistry?.has(name) ?? false;
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

  // `Direct(<routeId>)` wraps a registered direct route as a tool. The
  // LLM-facing tool name stays the valid `direct_<routeId>` form (tool
  // names cannot contain parentheses); `Direct(...)` is only the
  // reference grammar a developer writes in `tools([...])`.
  const directMatch = /^Direct\((.*)\)$/.exec(name);
  if (directMatch) {
    const routeId = directMatch[1]!.trim();
    if (routeId === "") {
      throw rcError("RC5003", undefined, {
        message: `tools(): "${name}" has an empty route id; use "Direct(<routeId>)".`,
      });
    }
    const toolName = `direct_${routeId}`;
    const wrapper = directTool(routeId);
    const fn = wrapper.resolve(ctx, toolName);
    return toResolvedTool(toolName, fn, guard);
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

/**
 * Recognise an attempted MCP tool reference. Two accepted forms: the
 * raw flat identity `mcp__<server>__<tool>` (also `mcp__<server>` and
 * `mcp__<server>__*` for a whole server), which is what Claude Code
 * agent files carry, and the `MCP(server:tool)` / `MCP(server)` sugar.
 *
 * Callers consult the fn registry first, so an exact fn id (even one
 * starting with `mcp__`) takes precedence over this grammar.
 *
 * @internal
 */
function isMcpRefName(name: string): boolean {
  if (name.startsWith("mcp__")) return true;
  return name.startsWith("MCP(") && name.endsWith(")");
}

/**
 * Parse an MCP reference into its server (client) and tool parts.
 * Accepts two forms:
 *
 * - Raw identity `mcp__<server>__<tool>`. Server and tool split on the
 *   first `__` after the `mcp__` prefix (so single-underscore server
 *   names like `my_company_api` are preserved). `mcp__<server>` and
 *   `mcp__<server>__*` select every tool on the server. This is the
 *   string Claude Code agent files carry, so they resolve unchanged.
 * - Sugar `MCP(server:tool)`. Colon-separated; `MCP(server)` and
 *   `MCP(server:*)` select every tool on the server.
 *
 * A `toolName` of `*` means "every tool on the server". Separators
 * beyond the first split (extra `__` in the raw form, extra `:` in the
 * sugar) stay in the tool segment and are forwarded to the MCP server
 * verbatim.
 *
 * @internal
 */
function parseMcpRef(ref: string): { clientName: string; toolName: string } {
  if (ref.startsWith("MCP(") && ref.endsWith(")")) {
    const inner = ref.slice(4, -1).trim();
    const colon = inner.indexOf(":");
    const clientName = colon === -1 ? inner : inner.slice(0, colon).trim();
    const toolName = colon === -1 ? "*" : inner.slice(colon + 1).trim();
    if (clientName === "" || toolName === "") {
      throw rcError("RC5003", undefined, {
        message: `tools(): MCP reference "${ref}" must use "MCP(server:tool)" or "MCP(server)"; got an empty server or tool segment.`,
      });
    }
    return { clientName, toolName };
  }
  if (ref.startsWith("mcp__")) {
    const rest = ref.slice("mcp__".length);
    const sep = rest.indexOf("__");
    const clientName = sep === -1 ? rest : rest.slice(0, sep);
    const toolName = sep === -1 ? "*" : rest.slice(sep + 2);
    if (clientName.trim() === "" || toolName.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `tools(): MCP reference "${ref}" must use "mcp__server__tool" or "mcp__server"; got an empty server or tool segment.`,
      });
    }
    return { clientName, toolName };
  }
  throw rcError("RC5003", undefined, {
    message: `tools(): MCP reference "${ref}" must use "MCP(server:tool)", "MCP(server)", or the raw "mcp__server__tool" form.`,
  });
}

/**
 * Resolve an MCP reference into one or more `ResolvedTool` entries.
 * The whole-server forms expand to every tool registered under the
 * server at dispatch time.
 *
 * Throws RC5003 when the registry is absent, the server is unknown,
 * the server is registered but has no tools, or the specific tool is
 * not registered.
 *
 * @internal
 */
function resolveMcpRefs(
  ctx: CraftContext,
  ref: string,
  guard: ToolGuard | undefined,
): ResolvedTool[] {
  const { clientName, toolName } = parseMcpRef(ref);
  const registry = ctx.getStore(MCP_TOOL_REGISTRY);
  if (!registry) {
    throw rcError("RC5003", undefined, {
      message: `tools(): MCP reference "${ref}" but no MCP_TOOL_REGISTRY is present. Install mcpPlugin (defineConfig.mcp) so external clients populate the registry.`,
    });
  }
  const clientTools = registry.getToolsByServer(clientName);
  if (clientTools.length === 0) {
    const known = listKnownMcpClients(registry);
    throw rcError("RC5003", undefined, {
      message:
        `tools(): MCP reference "${ref}" but client "${clientName}" has no registered tools. ` +
        (known.length > 0
          ? `Known MCP clients: ${known.map((k) => `"${k}"`).join(", ")}.`
          : `No MCP clients are registered in this context.`),
    });
  }
  if (toolName === "*") {
    return clientTools.map((entry) =>
      mcpEntryToResolvedTool(ctx, entry, guard),
    );
  }
  const entry = clientTools.find((t) => t.name === toolName);
  if (!entry) {
    const knownTools = clientTools.map((t) => t.name).sort();
    throw rcError("RC5003", undefined, {
      message:
        `tools(): MCP reference "${ref}" but tool "${toolName}" is not registered under client "${clientName}". ` +
        `Known tools on "${clientName}": ${knownTools.map((n) => `"${n}"`).join(", ")}.`,
    });
  }
  return [mcpEntryToResolvedTool(ctx, entry, guard)];
}

/**
 * Wrap an MCP registry entry as a `ResolvedTool`. The input is a
 * Standard Schema pass-through that exposes the entry's raw JSON
 * Schema to the Vercel AI SDK bridge (it consumes the
 * `~standard.jsonSchema` extension) and accepts the LLM-supplied
 * value unchanged (the MCP server is the source of truth for
 * validation; double-validating locally adds latency and divergence
 * risk).
 *
 * The handler captures the entry's `source` (client name) at
 * resolution time and dispatches via `dispatchMcpCall`, so a tool
 * call goes through the same stdio / HTTP plumbing as the `mcp(...)`
 * destination adapter.
 *
 * Auth boundary: the routecraft principal (`FnHandlerContext.principal`)
 * authenticates the caller into routecraft and is intentionally
 * NOT forwarded to the MCP server. The MCP client is authenticated
 * separately via the static credentials registered on
 * `defineConfig.mcp({ clients: { name: { auth } } })`. If the agent
 * needs to thread user-specific data into a tool call, it must do so
 * as a regular tool argument (e.g. include a `tenantId` field), never
 * by piggybacking on a credential. Two trust boundaries: principal
 * authenticates Routecraft; MCP `auth` authenticates the
 * Routecraft -> MCP hop.
 *
 * @internal
 */
function mcpEntryToResolvedTool(
  ctx: CraftContext,
  entry: McpToolRegistryEntry,
  guard: ToolGuard | undefined,
): ResolvedTool {
  const name = `mcp__${entry.source}__${entry.name}`;
  const description =
    entry.description && entry.description.trim() !== ""
      ? entry.description
      : `MCP tool "${entry.name}" on client "${entry.source}".`;
  const input = wrapJsonSchemaAsStandard(entry.inputSchema);
  const handler: FnOptions["handler"] = async (rawInput) => {
    // MCP tools expect a JSON-object argument. Silently coercing a
    // non-object value to `{}` would discard the LLM's args and surface
    // an unrelated server-side error; fail loudly so the model sees a
    // precise correction message and can retry with the right shape.
    if (
      rawInput === null ||
      rawInput === undefined ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput)
    ) {
      throw rcError("RC5003", undefined, {
        message: `mcp tool "${name}" expects an object argument; received ${rawInput === null ? "null" : Array.isArray(rawInput) ? "array" : typeof rawInput}.`,
      });
    }
    const args = rawInput as Record<string, unknown>;
    return dispatchMcpCall(ctx, entry.source, entry.name, args);
  };
  const tool: ResolvedTool = {
    name,
    description,
    input,
    handler,
  };
  if (entry.tags && entry.tags.length > 0) {
    tool.tags = [...entry.tags];
  }
  if (guard) tool.guard = guard;
  return tool;
}

/**
 * Lightweight Standard Schema wrapper around a raw JSON Schema. The
 * `~standard.validate` is a pass-through (MCP server validates); the
 * `~standard.jsonSchema` extension hands the JSON Schema to the
 * Vercel AI SDK bridge via `toAiInputSchema`. Follows the same shape
 * `emptyObjectSchema` in `builders.ts` uses so the bridge code stays
 * uniform.
 *
 * @internal
 */
function wrapJsonSchemaAsStandard(
  schema: Record<string, unknown>,
): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "routecraft",
      validate(value) {
        return { value };
      },
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    } as StandardSchemaV1<unknown, unknown>["~standard"],
  };
}

function listKnownMcpClients(registry: McpToolRegistry): string[] {
  const set = new Set<string>();
  for (const entry of registry.getTools()) set.add(entry.source);
  return [...set].sort();
}

/**
 * Parsed `from` scope filter. `kind: "all"` means walk every source
 * (default when `from` is unset). `kind: "mcp"` narrows to a single
 * MCP client.
 *
 * @internal
 */
interface FromScope {
  kind: "all" | "mcp";
  mcpClient?: string;
}

function parseFromScope(from: string | undefined): FromScope {
  if (from === undefined) return { kind: "all" };
  if (typeof from !== "string" || from.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `tools(): "from" must be a non-empty string when present.`,
    });
  }
  if (from.startsWith("mcp__")) {
    const client = from.slice("mcp__".length);
    if (client.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `tools(): from "${from}" has an empty server name; use "mcp__<server>".`,
      });
    }
    return { kind: "mcp", mcpClient: client };
  }
  throw rcError("RC5003", undefined, {
    message: `tools(): from "${from}" is not a supported source filter. Use "mcp__<server>".`,
  });
}

function resolveByTags(
  ctx: CraftContext,
  wanted: Tag[],
  guard: ToolGuard | undefined,
  from: string | undefined,
): ResolvedTool[] {
  const wantedSet = new Set(wanted);
  const scope = parseFromScope(from);
  const out: ResolvedTool[] = [];
  const seenNames = new Set<string>();
  // Track route ids already surfaced via a fn-registry directTool wrapper
  // **that actually contributed** so the direct-registry walk doesn't
  // double-include them. Wrappers that didn't match the wanted tag set
  // are NOT added here -- the underlying route may still match by its
  // own tags and is allowed to surface under its direct_<routeId> name.
  // MCP entries are walked separately at the end of this function via
  // MCP_TOOL_REGISTRY (not the fn-registry deferred path), so they
  // sit outside this dedup set.
  const coveredRouteIds = new Set<string>();

  // fn registry and direct registry walks only run when scope is
  // unrestricted ("all"). A scoped selector like
  // `{ tagged: "read-only", from: "mcp__Nuclino" }` deliberately
  // excludes fns and routes.
  if (scope.kind === "all") {
    // Walk the fn registry first so explicit fn-side tags (incl. directTool
    // wrappers) take precedence over a parallel direct-registry walk.
    // Skip non-direct deferred entries entirely (none exist today now that
    // `agentTool` is gone, but the guard is kept so future deferred kinds
    // do not silently surface here without an explicit by-name ref).
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
          // Direct routes register under their sanitised endpoint, but
          // `directTool` wrappers carry the user-supplied raw id. Store the
          // sanitised form so the direct-registry walk below (which
          // iterates the registry by its sanitised key) dedups correctly
          // even when the route id contains URL-special chars like "/".
          coveredRouteIds.add(sanitizeEndpoint(entry.targetId));
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
    // fn-registry wrapper. Registry keys are the sanitised endpoint;
    // `coveredRouteIds` is also keyed by the sanitised form so the
    // dedup works for raw ids containing URL-special characters.
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
  }

  // Walk the MCP registry. Under "all" scope every client is in
  // scope; under "mcp" scope only the named client contributes.
  const mcpRegistry = ctx.getStore(MCP_TOOL_REGISTRY);
  if (mcpRegistry) {
    let entries: McpToolRegistryEntry[];
    if (scope.kind === "mcp") {
      entries = mcpRegistry.getToolsByServer(scope.mcpClient as string);
      if (entries.length === 0) {
        const known = listKnownMcpClients(mcpRegistry);
        throw rcError("RC5003", undefined, {
          message:
            `tools(): from "mcp__${scope.mcpClient}" has no registered tools. ` +
            (known.length > 0
              ? `Known MCP clients: ${known.map((k) => `"${k}"`).join(", ")}.`
              : `No MCP clients are registered in this context.`),
        });
      }
    } else {
      entries = mcpRegistry.getTools();
    }
    for (const entry of entries) {
      const tags = entry.tags ?? [];
      if (!tags.some((t) => wantedSet.has(t))) continue;
      const tool = mcpEntryToResolvedTool(ctx, entry, guard);
      if (seenNames.has(tool.name)) continue;
      out.push(tool);
      seenNames.add(tool.name);
    }
  } else if (scope.kind === "mcp") {
    // Asked for a specific MCP client but the registry isn't installed.
    throw rcError("RC5003", undefined, {
      message: `tools(): from "mcp__${scope.mcpClient}" but no MCP_TOOL_REGISTRY is present. Install mcpPlugin (defineConfig.mcp).`,
    });
  }

  return out;
}

function formatTags(tags: Tag[]): string {
  return tags.length === 1
    ? `"${tags[0]}"`
    : `[${tags.map((t) => `"${t}"`).join(", ")}]`;
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
  ].map((id) => `Direct(${id})`);
  return [...fnNames, ...routeNames].sort();
}
