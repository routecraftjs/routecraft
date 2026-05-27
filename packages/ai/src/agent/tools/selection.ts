import {
  ADAPTER_DIRECT_REGISTRY,
  rcError,
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
 */
export type ToolsItem =
  | string
  | { name: string; guard?: ToolGuard; description?: string };

/**
 * Read-only snapshot of every tool registered in the live context,
 * handed to the function form of `tools()`. Lets a builder filter or
 * compose a list without baking selector languages into the framework
 * (a "give me all read-only fns" predicate is the user's `.filter()`
 * call, not a framework-blessed primitive).
 *
 * Walking the snapshot is the explicit, code-visible way to extend an
 * agent's tool surface across registrations: a future fn whose tags
 * match the predicate will silently extend the surface the next time
 * `resolve()` runs. The function form makes that visible at the call
 * site, where a `.filter()` is the obvious signal that the set is
 * dynamic.
 */
export interface ToolsCatalog {
  /**
   * Plain fn entries from `agentPlugin({ functions })`. Deferred
   * wrappers (e.g. `directTool(routeId)`) appear here too with their
   * canonical name and the override tags supplied at builder time.
   */
  readonly fns: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly Tag[];
  }>;
  /**
   * Direct routes registered in `ADAPTER_DIRECT_REGISTRY`. Reference
   * them in a `ToolsItem` as `"Direct(<id>)"`.
   */
  readonly routes: ReadonlyArray<{
    readonly id: string;
    readonly description?: string;
    readonly tags?: readonly Tag[];
  }>;
  /**
   * MCP tools populated by `mcpPlugin({ clients })`. Reference them in
   * a `ToolsItem` as `"MCP(<server>:<tool>)"` or
   * `"mcp__<server>__<tool>"`.
   */
  readonly mcp: ReadonlyArray<{
    readonly server: string;
    readonly tool: string;
    readonly description?: string;
    readonly tags?: readonly Tag[];
  }>;
}

/**
 * Builder form of `tools()`. Receives a snapshot of the registered
 * tools and returns the list of references to expose. Same return
 * shape as the array form, so the rest of resolution is identical.
 */
export type ToolsBuilder = (catalog: ToolsCatalog) => ToolsItem[];

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
 */
export interface ToolSelection {
  readonly [TOOL_SELECTION_BRAND]: true;
  /**
   * Resolve the selection against the live context. Throws RC5003 on
   * any unresolvable explicit reference (unknown name, deferred
   * resolution failure).
   */
  readonly resolve: (ctx: CraftContext) => ResolvedTool[];
}

/**
 * A tool ready to be wired into the LLM tool list. Produced by
 * `ToolSelection.resolve()`.
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
 * Build a tool selection for an agent.
 *
 * Two forms:
 *
 * - **Array**: `tools([...])` -- explicit enumeration of references.
 *   Resolution happens lazily at agent dispatch time. Items are bare
 *   strings or `{ name, guard?, description? }` objects.
 * - **Builder**: `tools((catalog) => [...])` -- programmatic selection.
 *   Receives a snapshot of the live fn / route / MCP registries and
 *   returns the same shape the array form accepts. Use this as the
 *   escape hatch when explicit enumeration is impractical (e.g. "give
 *   me every read-only fn"); the predicate lives in your code so the
 *   implicit-extension behaviour is visible at the call site.
 *
 * Resolution rules:
 *
 * - Bare names look up exact matches in the fn registry first.
 *   `Direct(<routeId>)` wraps a direct route via `directTool` (the
 *   LLM-facing tool name stays `direct_<routeId>`). `MCP(server:tool)`
 *   / `MCP(server)` and the raw `mcp__server__tool` / `mcp__server` /
 *   `mcp__server__*` forms resolve against `MCP_TOOL_REGISTRY`.
 * - Final list is deduplicated by tool name; later refs to the same
 *   name win (so a user's builder can override a tag-derived entry
 *   simply by listing it explicitly).
 *
 * @example Array form
 * ```ts
 * agent({
 *   tools: tools([
 *     "currentTime",
 *     "fetchOrder",
 *     "Direct(cancel-order)",
 *     "MCP(github:create_issue)",
 *     { name: "sendSlack", guard: confirmGuard },
 *   ]),
 * });
 * ```
 *
 * @example Builder form
 * ```ts
 * agent({
 *   tools: tools((catalog) => [
 *     "fetchOrder",
 *     ...catalog.fns
 *       .filter((f) => f.tags?.includes("read-only"))
 *       .map((f) => f.name),
 *   ]),
 * });
 * ```
 */
export function tools(items: ToolsItem[]): ToolSelection;
export function tools(builder: ToolsBuilder): ToolSelection;
export function tools(arg: ToolsItem[] | ToolsBuilder): ToolSelection {
  if (typeof arg !== "function" && !Array.isArray(arg)) {
    throw rcError("RC5003", undefined, {
      message: `tools(): argument must be an array of ToolsItem or a (catalog) => ToolsItem[] builder.`,
    });
  }
  return {
    [TOOL_SELECTION_BRAND]: true,
    resolve(ctx) {
      const items =
        typeof arg === "function" ? runBuilder(arg, buildCatalog(ctx)) : arg;
      const out = new Map<string, ResolvedTool>();
      for (const item of items) {
        if (typeof item === "string") {
          // An exact fn id always wins over the MCP-ref grammar, so a fn
          // whose id happens to start with `mcp__` stays reachable.
          if (isMcpRefName(item) && !fnRegistryHas(ctx, item)) {
            for (const tool of resolveMcpRefs(ctx, item, undefined)) {
              out.set(tool.name, tool);
            }
            continue;
          }
          const tool = resolveByName(ctx, item, undefined);
          out.set(tool.name, tool);
          continue;
        }
        if (item === null || typeof item !== "object" || !("name" in item)) {
          throw rcError("RC5003", undefined, {
            message: `tools(): each item must be a string or { name, guard?, description? }.`,
          });
        }
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
            out.set(tool.name, tool);
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
        out.set(tool.name, tool);
      }
      return [...out.values()];
    },
  };
}

/**
 * Build a {@link ToolsCatalog} snapshot from the live context's
 * registries. Each entry is a plain readonly object; `Object.freeze`
 * is not applied because the catalog is single-use per dispatch and
 * the cost of freezing every entry would dominate the function-form
 * fast path for no real safety gain (the caller can mutate at will,
 * but mutations don't persist into the registries).
 *
 * @internal
 */
function buildCatalog(ctx: CraftContext): ToolsCatalog {
  const fns: Array<{
    name: string;
    description?: string;
    tags?: readonly Tag[];
  }> = [];
  const fnRegistry = ctx.getStore(ADAPTER_FN_REGISTRY) as
    | Map<string, FnEntry>
    | undefined;
  if (fnRegistry) {
    for (const [name, entry] of fnRegistry) {
      if (isDeferredFn(entry)) {
        // Deferred wrappers don't carry their own description/tags in
        // the registry; users who want to filter on those should walk
        // catalog.routes for the underlying route, then reference it
        // as `Direct(<routeId>)` in the returned items list.
        fns.push({ name });
      } else {
        const item: {
          name: string;
          description?: string;
          tags?: readonly Tag[];
        } = {
          name,
          description: entry.description,
        };
        if (entry.tags && entry.tags.length > 0) item.tags = entry.tags;
        fns.push(item);
      }
    }
  }

  const routes: Array<{
    id: string;
    description?: string;
    tags?: readonly Tag[];
  }> = [];
  const directRegistry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;
  if (directRegistry) {
    for (const [routeId, meta] of directRegistry) {
      const item: { id: string; description?: string; tags?: readonly Tag[] } =
        {
          id: routeId,
        };
      if (meta.description) item.description = meta.description;
      if (meta.tags && meta.tags.length > 0) item.tags = meta.tags;
      routes.push(item);
    }
  }

  const mcp: Array<{
    server: string;
    tool: string;
    description?: string;
    tags?: readonly Tag[];
  }> = [];
  const mcpRegistry = ctx.getStore(MCP_TOOL_REGISTRY);
  if (mcpRegistry) {
    for (const entry of mcpRegistry.getTools()) {
      const item: {
        server: string;
        tool: string;
        description?: string;
        tags?: readonly Tag[];
      } = {
        server: entry.source,
        tool: entry.name,
      };
      if (entry.description) item.description = entry.description;
      if (entry.tags && entry.tags.length > 0) item.tags = entry.tags;
      mcp.push(item);
    }
  }

  return { fns, routes, mcp };
}

/**
 * Invoke a user-supplied tools builder safely and surface failures as
 * RC5003 with the original error chained. Validates that the return
 * is an array so a confused builder doesn't silently produce nothing.
 *
 * @internal
 */
function runBuilder(builder: ToolsBuilder, catalog: ToolsCatalog): ToolsItem[] {
  let items: unknown;
  try {
    items = builder(catalog);
  } catch (cause) {
    throw rcError("RC5003", cause, {
      message: `tools(builder): builder threw: ${(cause as Error)?.message ?? String(cause)}`,
    });
  }
  if (!Array.isArray(items)) {
    throw rcError("RC5003", undefined, {
      message: `tools(builder): builder must return an array of ToolsItem (got ${typeof items}).`,
    });
  }
  return items as ToolsItem[];
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
