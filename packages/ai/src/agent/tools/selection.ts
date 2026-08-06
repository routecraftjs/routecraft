import { rcError, type CraftContext, type Tag } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ADAPTER_FN_REGISTRY } from "../../fn/store.ts";
import type { FnOptions, ToolGuard } from "../../fn/types.ts";
import { dispatchMcpCall } from "../../mcp/dispatch.ts";
import {
  MCP_TOOL_REGISTRY,
  type McpToolRegistryEntry,
} from "../../mcp/types.ts";
import type { McpToolRegistry } from "../../mcp/tool-registry.ts";
import { directTool } from "./builders.ts";
import { isDeferredFn, type FnEntry } from "./types.ts";
import {
  describeToolNameViolation,
  TOOL_NAME_PATTERN_SOURCE,
  TOOL_NAME_SEPARATOR,
} from "../../tool-name.ts";
import type { AgentToolSource } from "./policy.ts";

/**
 * Wire-form prefix for a direct capability exposed as an agent tool.
 * `Direct(<routeId>)` is the authoring grammar; `direct__<routeId>` is
 * what the model sees, because a tool name cannot carry parentheses.
 *
 * `__` is the structural separator throughout (see
 * {@link TOOL_NAME_SEPARATOR}), so a route id containing a single
 * underscore stays unambiguous against the prefix boundary.
 *
 * @internal
 */
export const DIRECT_TOOL_PREFIX = `direct${TOOL_NAME_SEPARATOR}`;

/**
 * Wire-form prefix for an external MCP client tool. Already used the
 * `__` separator before the rest of the surface was normalised onto it,
 * and matches the `mcp__<server>__<tool>` names Claude Code agent files
 * carry, so those files resolve unchanged.
 *
 * @internal
 */
export const MCP_TOOL_PREFIX = `mcp${TOOL_NAME_SEPARATOR}`;

/**
 * Reject a `Direct(<routeId>)` reference whose route id cannot survive
 * as a provider-facing tool name.
 *
 * Route ids are deliberately unconstrained in core: `memory:get` and
 * `orders/cancel` are legitimate and are used as such by
 * `CraftClient.sendDirect` and `BlockClient.forward`. Only the agent
 * tool surface has to satisfy the provider charset, so the constraint
 * is enforced here, at the point of exposure, rather than pushed back
 * onto every route id in the codebase.
 *
 * We reject rather than transliterate on purpose. Any encoding that
 * maps the full route-id space into `[A-Za-z0-9_-]` produces names the
 * model has to read (`direct__memory_x3A_get`), and tool names are part
 * of the prompt: degrading them degrades tool selection. Rejecting
 * keeps every generated name legible and leaves the developer with the
 * better escape hatch, which already exists and is named in the error:
 * register the route under a clean fn id with `directTool(routeId)`.
 *
 * @internal
 */
function assertValidDirectToolName(
  ref: string,
  routeId: string,
  toolName: string,
): void {
  const violation = describeToolNameViolation(toolName);
  if (violation === undefined) return;
  throw rcError("RC5003", undefined, {
    message: `tools(): "${ref}" resolves to the tool name "${toolName}", which the model provider will reject: ${violation}.`,
    suggestion:
      `Route ids are unconstrained, but tool names must match ${TOOL_NAME_PATTERN_SOURCE}. ` +
      `Expose this route under a tool-safe name instead: ` +
      `agentPlugin({ functions: { yourToolName: directTool("${routeId}") } }), ` +
      `then reference "yourToolName" in tools([...]).`,
  });
}

/**
 * Re-exported from `fn/types.ts`, where the guard type lives so both the
 * agent tool bridge and the MCP proxy (`mcpPlugin({ proxy })`) share one
 * guard contract. Kept here so existing imports keep working.
 */
export type { ToolGuard } from "../../fn/types.ts";

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
  string | { name: string; guard?: ToolGuard; description?: string };

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
   * Discoverable direct routes (see `CraftContext.capabilities()`).
   * Reference them in a `ToolsItem` as `"Direct(<id>)"`.
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
   *
   * One deliberate exception: an MCP client tool whose composed wire
   * name is unusable is DROPPED with a warning rather than thrown, even
   * when named explicitly. The remote owns that name, and resolution
   * runs per dispatch, so throwing would turn a remote renaming a tool
   * into a live route outage instead of a startup error. See
   * {@link resolveMcpRefs}.
   */
  readonly resolve: (ctx: CraftContext) => ResolvedTool[];
}

/**
 * A tool ready to be wired into the LLM tool list. Produced by
 * `ToolSelection.resolve()`.
 */
export interface ResolvedTool {
  /** Tool name presented to the LLM: the registered fn id, `direct__<routeId>` for capabilities, or `mcp__<server>__<tool>` for MCP tools. */
  name: string;
  /** Description shown to the LLM. */
  description: string;
  /** Standard Schema validating the LLM-supplied input. */
  input: StandardSchemaV1<unknown, unknown>;
  /** Optional tags inherited from the underlying registration. */
  tags?: Tag[];
  /** Optional guard run after validation, before the handler. */
  guard?: ToolGuard;
  /**
   * Where this tool came from. Set by the resolver, never by user
   * config, so `agentPlugin({ toolPolicy })` can treat it as trusted
   * provenance when deciding admission.
   */
  source: AgentToolSource;
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
 *   LLM-facing tool name becomes `direct__<routeId>`).
 *   `MCP(server:tool)` / `MCP(server)` and the raw `mcp__server__tool`
 *   / `mcp__server` / `mcp__server__*` forms resolve against
 *   `MCP_TOOL_REGISTRY`.
 *
 * Two grammars, deliberately distinct. `Direct(<routeId>)` and
 * `MCP(server:tool)` are what a developer writes, here and in markdown
 * agent frontmatter. `direct__<routeId>` and `mcp__<server>__<tool>`
 * are the wire names the model sees, because tool names carry neither
 * parentheses nor colons. Normalisation happens at resolution; nothing
 * outside this module should construct a wire name by hand.
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
 * registries. Each entry and its `tags` array are frozen so the
 * interface's `readonly` modifiers match runtime behaviour: a builder
 * cannot mutate an entry's name / description / tags in place and have
 * it silently affect the rest of resolution. Freeze cost is negligible
 * for a per-dispatch snapshot of a handful of registry entries.
 *
 * @internal
 */
function buildCatalog(ctx: CraftContext): ToolsCatalog {
  const fns: ToolsCatalog["fns"][number][] = [];
  const fnRegistry = ctx.getStore(ADAPTER_FN_REGISTRY) as
    Map<string, FnEntry> | undefined;
  if (fnRegistry) {
    for (const [name, entry] of fnRegistry) {
      if (isDeferredFn(entry)) {
        // Deferred wrappers don't carry their own description/tags in
        // the registry; users who want to filter on those should walk
        // catalog.routes for the underlying route, then reference it
        // as `Direct(<routeId>)` in the returned items list.
        fns.push(Object.freeze({ name }));
      } else {
        const tags =
          entry.tags && entry.tags.length > 0
            ? Object.freeze([...entry.tags])
            : undefined;
        fns.push(
          Object.freeze({
            name,
            description: entry.description,
            ...(tags !== undefined ? { tags } : {}),
          }),
        );
      }
    }
  }

  const routes: ToolsCatalog["routes"][number][] = [];
  // `capabilities()` already speaks raw route ids (it decodes the
  // sanitised registry keys), so a builder that does `Direct(${r.id})`
  // resolves cleanly for ids containing `/`, `:`, etc.
  for (const meta of ctx.capabilities()) {
    const tags =
      meta.tags && meta.tags.length > 0
        ? Object.freeze([...meta.tags])
        : undefined;
    routes.push(
      Object.freeze({
        id: meta.endpoint,
        ...(meta.description ? { description: meta.description } : {}),
        ...(tags !== undefined ? { tags } : {}),
      }),
    );
  }

  const mcp: ToolsCatalog["mcp"][number][] = [];
  const mcpRegistry = ctx.getStore(MCP_TOOL_REGISTRY);
  if (mcpRegistry) {
    for (const entry of mcpRegistry.getTools()) {
      const tags =
        entry.tags && entry.tags.length > 0
          ? Object.freeze([...entry.tags])
          : undefined;
      mcp.push(
        Object.freeze({
          server: entry.source,
          tool: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(tags !== undefined ? { tags } : {}),
        }),
      );
    }
  }

  return Object.freeze({
    fns: Object.freeze(fns),
    routes: Object.freeze(routes),
    mcp: Object.freeze(mcp),
  });
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
    Map<string, FnEntry> | undefined;
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
    Map<string, FnEntry> | undefined;
  const fnEntry = fnRegistry?.get(name);
  if (fnEntry) {
    return resolveFnEntry(ctx, name, fnEntry, guard);
  }

  // `Direct(<routeId>)` wraps a registered direct route as a tool. The
  // LLM-facing tool name is the `direct__<routeId>` wire form (tool
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
    const toolName = `${DIRECT_TOOL_PREFIX}${routeId}`;
    assertValidDirectToolName(name, routeId, toolName);
    const wrapper = directTool(routeId);
    const fn = wrapper.resolve(ctx, toolName);
    return toResolvedTool(toolName, fn, guard, { kind: "direct", routeId });
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
    // Derived from `entry.kind`, never asserted. `isDeferredFn` is a
    // brand check only, so hardcoding "direct" here would silently
    // classify a future deferred kind (a sub-agent tool is the named
    // candidate) as a capability, admitting it under any policy that
    // sets `direct: true`. The exhaustive default turns adding a kind
    // into a compile error, which is the whole point of the allowlist
    // narrowing rather than widening.
    switch (entry.kind) {
      case "direct":
        // A `directTool(routeId)` registered under a fn id is still a
        // capability: it reaches the same route, only under a different
        // name. Reporting it as `fn` would let an alias slip past a
        // policy that denies `direct`.
        return toResolvedTool(name, fn, guard, {
          kind: "direct",
          routeId: entry.targetId,
        });
      default: {
        const exhaustive: never = entry.kind;
        throw rcError("RC5003", undefined, {
          message: `tools(): fn "${name}" has an unsupported deferred kind "${String(exhaustive)}", so it carries no tool-policy provenance and cannot be resolved.`,
        });
      }
    }
  }
  return toResolvedTool(name, entry, guard, { kind: "fn", id: name });
}

function toResolvedTool(
  name: string,
  fn: FnOptions,
  guard: ToolGuard | undefined,
  source: AgentToolSource,
): ResolvedTool {
  return {
    name,
    description: fn.description,
    input: fn.input as StandardSchemaV1<unknown, unknown>,
    ...(fn.tags && fn.tags.length > 0 ? { tags: fn.tags } : {}),
    ...(guard ? { guard } : {}),
    source,
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
  if (name.startsWith(MCP_TOOL_PREFIX)) return true;
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
  if (ref.startsWith(MCP_TOOL_PREFIX)) {
    const rest = ref.slice(MCP_TOOL_PREFIX.length);
    const sep = rest.indexOf(TOOL_NAME_SEPARATOR);
    const clientName = sep === -1 ? rest : rest.slice(0, sep);
    const toolName =
      sep === -1 ? "*" : rest.slice(sep + TOOL_NAME_SEPARATOR.length);
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
 * Does NOT throw when a registered tool's composed wire name is
 * unusable: that tool is dropped with a warning, on both the wildcard
 * and the explicit-reference path. The name comes from the remote
 * rather than from this repository, and `resolve` runs per dispatch, so
 * a throw would let a remote rename take down every dispatch of every
 * agent bound to that server. Uniform dropping also keeps the two paths
 * behaving the same, which is easier to reason about than a rule that
 * depends on how the tool happened to be referenced.
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
    return clientTools
      .map((entry) => mcpEntryToResolvedTool(ctx, entry, guard))
      .filter((tool): tool is ResolvedTool => tool !== undefined);
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
  const resolved = mcpEntryToResolvedTool(ctx, entry, guard);
  return resolved === undefined ? [] : [resolved];
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
): ResolvedTool | undefined {
  // A client name containing `__` makes the wire name unparseable.
  // `parseMcpRef` splits at the FIRST separator after the prefix, so a
  // server called `a__b` exposing `c` generates `mcp__a__b__c`, which
  // reads back as server `a` with tool `b__c`: a valid-looking name
  // that resolves to the wrong thing, or to nothing.
  //
  // Constraining the server rather than the tool is what makes the
  // grammar unambiguous, and it is the half we own: client names are
  // chosen locally in `mcpPlugin({ clients })`, while tool names come
  // from the remote. With no `__` in the server, the first-separator
  // split is always correct and a remote may use `__` in its tool
  // names freely.
  if (entry.source.includes(TOOL_NAME_SEPARATOR)) {
    ctx.logger.warn(
      { server: entry.source, tool: entry.name },
      `MCP client name contains "${TOOL_NAME_SEPARATOR}", which makes the generated tool name ambiguous to parse; dropping its tools from the agent's tool list. Rename the client in mcpPlugin({ clients }) so it has no "${TOOL_NAME_SEPARATOR}".`,
    );
    return undefined;
  }
  const name = `${MCP_TOOL_PREFIX}${entry.source}${TOOL_NAME_SEPARATOR}${entry.name}`;
  // The remote names its own tools, so this is the one composed name
  // built from input nobody in this repository authored. An unusable
  // name is dropped with a warning rather than thrown, matching what
  // the MCP proxy already does for the same registry entries
  // (`mcp/proxy.ts`): a throw here would let one malformed remote tool
  // fail every dispatch of every agent bound to that server, and
  // because `resolve()` runs per dispatch, a remote renaming a tool
  // would become a live route outage rather than a startup error.
  const violation = describeToolNameViolation(name);
  if (violation !== undefined) {
    ctx.logger.warn(
      { server: entry.source, tool: entry.name, toolName: name },
      `MCP tool name is not usable as a provider tool name (${violation}); dropping it from the agent's tool list. Expose it through a capability under a tool-safe name if the agent needs it.`,
    );
    return undefined;
  }
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
    // Raw annotations ride along beside the derived tags. `tags` cannot
    // distinguish "the server declared this safe" from "the server said
    // nothing", because tag derivation only fires on a truthy hint, and
    // the MCP defaults for an absent hint are not uniformly false.
    source: {
      kind: "mcp",
      server: entry.source,
      tool: entry.name,
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
    },
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
    ...(ctx.getStore(ADAPTER_FN_REGISTRY) ?? new Map<string, FnEntry>()).keys(),
  ];
  const routeNames = ctx.capabilities().map((c) => `Direct(${c.endpoint})`);
  return [...fnNames, ...routeNames].sort();
}
