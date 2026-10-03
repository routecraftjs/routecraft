import {
  CraftClient,
  type Capability,
  type CraftContext,
  type ExchangeHeaders,
  type PluginLogger,
} from "@routecraft/routecraft";
import type { FnOptions } from "../../fn/types.ts";
import { AgentSessionRuntime } from "../session/runtime.ts";

/**
 * Discriminator value for {@link LazyFn}. Plain symbol so a
 * `typeof entry === "object" && BRAND in entry` check is enough for
 * runtime detection without leaking implementation details.
 *
 * @internal
 */
export const LAZY_FN_BRAND = Symbol.for("routecraft.ai.fn.lazy");

/**
 * Marks the `FnOptions` a `directTool(routeId, { background: true })`
 * resolves to, so the agent's tool list can tell a background tool from
 * a synchronous one without re-reading the builder's overrides. A symbol
 * rather than a field, because `FnOptions` is the public shape an author
 * writes and this is resolver-set provenance, not something to author.
 *
 * @internal
 */
export const FN_BACKGROUND = Symbol.for("routecraft.ai.fn.background");

/**
 * Whether resolved fn options carry the background marker.
 *
 * @internal
 */
export function isBackgroundFn(fn: FnOptions): boolean {
  return (fn as { [FN_BACKGROUND]?: unknown })[FN_BACKGROUND] === true;
}

/**
 * The kinds of underlying things `tools(...)` can wrap as a deferred
 * fn. Today only `directTool(routeId)` produces a deferred entry;
 * MCP tools are resolved directly from the MCP plugin's tool registry at
 * selection time, and sub-agent tools are not yet supported. The
 * kind is purely informational at runtime (used for error messages
 * and the prefix-auto-resolution path in `tools()`).
 */
export type LazyFnKind = "direct";

/**
 * A fn that cannot be fully constructed at config-write time because it
 * depends on registries (direct route metadata, agent registrations,
 * MCP tool descriptors) that aren't populated until later in the
 * context lifecycle.
 *
 * Created by the builder helpers; the `agentPlugin` stores deferred
 * entries unmodified, and the agent runtime calls `.resolve(ctx, id)`
 * just before building the LLM tool list, when all registries are live.
 */
export interface LazyFn {
  readonly [LAZY_FN_BRAND]: true;
  /** Underlying source kind. Surfaces in error messages. */
  readonly kind: LazyFnKind;
  /**
   * The underlying registered id this wrapper targets (route id for
   * `direct`). Surfaced in error messages so authors can find the
   * offending registration when resolution fails.
   */
  readonly targetId: string;
  /**
   * Resolve to a concrete `FnOptions`. Throws `RC5003` with a clear
   * message if the underlying registry entry is missing or incomplete.
   *
   * @param ctx - Live context (registries populated)
   * @param fnId - The fn id this descriptor was registered as (used in
   *   error messages so the user can find the offending config entry)
   */
  readonly resolve: (host: ToolHost, fnId: string) => FnOptions;
}

/**
 * What resolving and dispatching a deferred tool needs from the
 * application: the routes it can reach and a way to call them. Built from
 * the context at dispatch ({@link toolHostOf}), and from the agent
 * runtime's plugin context at start, so both resolve a tool the same way.
 *
 * @internal
 */
export interface ToolHost {
  readonly logger: PluginLogger;
  /** Discoverable capabilities of the enabled routes. */
  capabilities(): Capability[];
  /** Whether a route with this id is registered at all. */
  hasRoute(routeId: string): boolean;
  /** Send a body to a direct endpoint and resolve with its reply. */
  deliver(
    endpoint: string,
    body: unknown,
    headers?: ExchangeHeaders,
  ): Promise<unknown>;
  /** The session runtime a background tool reports to. */
  sessions(): AgentSessionRuntime;
}

/**
 * The tool host for a running context.
 *
 * @internal
 */
export function toolHostOf(ctx: CraftContext): ToolHost {
  return {
    logger: ctx.logger,
    capabilities: () => ctx.capabilities(),
    hasRoute: (routeId) => ctx.getRouteById(routeId) !== undefined,
    deliver: (endpoint, body, headers) =>
      new CraftClient(ctx).sendDirect(endpoint, body, headers),
    sessions: () => AgentSessionRuntime.for(ctx),
  };
}

/**
 * Type guard. Returns true when the value is a deferred fn descriptor
 * emitted by `directTool`.
 *
 * @internal
 */
export function isLazyFn(value: unknown): value is LazyFn {
  return (
    typeof value === "object" &&
    value !== null &&
    LAZY_FN_BRAND in value &&
    (value as { [LAZY_FN_BRAND]: unknown })[LAZY_FN_BRAND] === true
  );
}

/**
 * What the fn registry actually holds. Eagerly authored fns are stored
 * as `FnOptions`; entries from `directTool` are stored as `LazyFn`
 * and resolved on first agent dispatch.
 */
export type FnEntry = FnOptions | LazyFn;

/**
 * The declared shape of a registered tool, whichever way it was authored.
 *
 * A deferred entry is a thunk until the registries it depends on are
 * live, and reading its fields before that yields nothing. Nothing about
 * the tool is missing at that point; the resolution simply has not
 * happened. Every path that wants a tool's description, input schema or
 * tags goes through here so the difference stops being observable:
 * after context start a lazily-resolved tool answers the same questions
 * an eagerly authored one does.
 *
 * @param host - The live application, with registries populated
 * @param fnId - The id the entry is registered under, for diagnostics
 * @param entry - The registered entry
 * @param memo - Where resolutions are kept: the agent registry's, so one
 *   made at start is reused at dispatch
 * @throws RC5003 when a deferred entry cannot resolve (the route is
 *   missing, or carries no `.description()` or `.input()`)
 *
 * @internal
 */
export function resolveFnOptions(
  host: ToolHost,
  fnId: string,
  entry: FnEntry,
  memo: Map<string, FnOptions>,
): FnOptions {
  if (!isLazyFn(entry)) return entry;
  const cached = memo.get(fnId);
  if (cached) return cached;
  const resolved = entry.resolve(host, fnId);
  // Only successes are memoised. A resolution that failed because a route
  // was not registered yet must be free to succeed later; caching the
  // failure would make a transient ordering problem permanent for the
  // life of the application.
  memo.set(fnId, resolved);
  return resolved;
}
