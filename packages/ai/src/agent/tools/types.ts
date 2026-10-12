import {
  CraftClient,
  routeCanDefer,
  type Capability,
  type CraftContext,
  type ExchangeHeaders,
  type Tag,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FnHandlerContext } from "../../fn/types.ts";
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
 * Marks the `FnOptions` a background direct tool resolves to, so the agent's
 * tool list can tell a background tool from a synchronous one without
 * re-reading the builder's overrides. A symbol rather than a field, because
 * `FnOptions` is the public shape an author writes and this is resolver-set
 * provenance, not something to author.
 *
 * The value says why: `"parks"` when the route can park, which makes the
 * tool background whatever the author declared, and `"declared"` when the
 * author asked for `background: true` on a route that does not park. The
 * resolved tool carries it too, so the reason stays off the public type.
 *
 * @internal
 */
export const FN_BACKGROUND = Symbol.for("routecraft.ai.fn.background");

/** Why a direct tool runs in the background. @internal */
export type BackgroundReason = "parks" | "declared";

/**
 * Why resolved fn options, or the tool resolved from them, run in the
 * background, or `undefined` for a synchronous tool. `true` is the marker a
 * copy of this package from before the reason existed sets.
 *
 * @internal
 */
export function backgroundReasonOf(
  resolved: object,
): BackgroundReason | undefined {
  const marker = (resolved as { [FN_BACKGROUND]?: unknown })[FN_BACKGROUND];
  if (marker === true) return "declared";
  return marker === "parks" || marker === "declared" ? marker : undefined;
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
   * Resolve to a concrete {@link RegisteredFn}. Throws `RC5003` with a clear
   * message if the underlying registry entry is missing or incomplete.
   *
   * @param ctx - Live context (registries populated)
   * @param fnId - The fn id this descriptor was registered as (used in
   *   error messages so the user can find the offending config entry)
   */
  readonly resolve: (host: ToolHost, fnId: string) => RegisteredFn;
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
  /** Discoverable capabilities of the enabled routes. */
  capabilities(): Capability[];
  /** Whether a route with this id is registered at all. */
  hasRoute(routeId: string): boolean;
  /**
   * Whether an exchange on this route can park, so a tool over it is
   * background by shape: the dispatch answers with an acknowledgment and
   * the result arrives from execution two. False for a route this
   * application does not hold, a remote's included.
   */
  canDefer(routeId: string): boolean;
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
    capabilities: () => ctx.capabilities(),
    hasRoute: (routeId) => ctx.getRouteById(routeId) !== undefined,
    canDefer: (routeId) => {
      const route = ctx.getRouteById(routeId);
      return route !== undefined && routeCanDefer(route.definition, ctx);
    },
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
 * A fn as the heterogeneous registry holds it: its input type erased, so
 * fns over unrelated schemas share one record.
 *
 * `handler` is a method here, and only here, so its parameter is checked
 * bivariantly and every `FnOptions<TIn, TOut>` is assignable to this shape
 * while `FnOptions` and `FnDefinition` keep a contravariant property. The
 * erasure is sound at the one place a registered handler is called: the
 * bridge validates the model's input against `input` first, and `input` is
 * the schema whose output typed that handler. A bare object literal written
 * straight into a `functions` record is typed against this shape, so its
 * handler sees `unknown`; wrap it in `fn()` to type it by its schema.
 */
export interface RegisteredFn {
  readonly description: string;
  readonly input: StandardSchemaV1;
  handler(input: unknown, ctx: FnHandlerContext): unknown;
  tags?: Tag[];
}

/**
 * What the fn registry actually holds. Eagerly authored fns are stored
 * as {@link RegisteredFn}; entries from `directTool` are stored as
 * `LazyFn` and resolved on first agent dispatch.
 */
export type FnEntry = RegisteredFn | LazyFn;

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
  memo: Map<string, RegisteredFn>,
): RegisteredFn {
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
