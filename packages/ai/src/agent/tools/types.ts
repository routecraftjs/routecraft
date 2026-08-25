import type { CraftContext } from "@routecraft/routecraft";
import type { FnOptions } from "../../fn/types.ts";

/**
 * Discriminator value for {@link DeferredFn}. Plain symbol so a
 * `typeof entry === "object" && BRAND in entry` check is enough for
 * runtime detection without leaking implementation details.
 *
 * @internal
 */
export const DEFERRED_FN_BRAND = Symbol.for("routecraft.ai.fn.deferred");

/**
 * The kinds of underlying things `tools(...)` can wrap as a deferred
 * fn. Today only `directTool(routeId)` produces a deferred entry;
 * MCP tools are resolved directly from `MCP_TOOL_REGISTRY` at
 * selection time, and sub-agent tools are not yet supported. The
 * kind is purely informational at runtime (used for error messages
 * and the prefix-auto-resolution path in `tools()`).
 */
export type DeferredFnKind = "direct";

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
export interface DeferredFn {
  readonly [DEFERRED_FN_BRAND]: true;
  /** Underlying source kind. Surfaces in error messages. */
  readonly kind: DeferredFnKind;
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
  readonly resolve: (ctx: CraftContext, fnId: string) => FnOptions;
}

/**
 * Type guard. Returns true when the value is a deferred fn descriptor
 * emitted by `directTool`.
 *
 * @internal
 */
export function isDeferredFn(value: unknown): value is DeferredFn {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFERRED_FN_BRAND in value &&
    (value as { [DEFERRED_FN_BRAND]: unknown })[DEFERRED_FN_BRAND] === true
  );
}

/**
 * What the fn registry actually holds. Eagerly authored fns are stored
 * as `FnOptions`; entries from `directTool` are stored as `DeferredFn`
 * and resolved on first agent dispatch.
 */
export type FnEntry = FnOptions | DeferredFn;

/**
 * Resolved `FnOptions` per context, so one dispatch resolves a deferred
 * entry once however many paths read it.
 *
 * Only successes are cached. A resolution that failed because a route
 * was not registered yet must be free to succeed later; caching the
 * failure would make a transient ordering problem permanent for the
 * life of the context.
 */
const RESOLVED = new WeakMap<CraftContext, Map<string, FnOptions>>();

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
 * @param ctx - Live context, with registries populated
 * @param fnId - The id the entry is registered under, for diagnostics
 * @throws RC5003 when a deferred entry cannot resolve (the route is
 *   missing, or carries no `.description()` or `.input()`)
 *
 * @internal
 */
export function resolveFnOptions(
  ctx: CraftContext,
  fnId: string,
  entry: FnEntry,
): FnOptions {
  if (!isDeferredFn(entry)) return entry;
  const cached = RESOLVED.get(ctx)?.get(fnId);
  if (cached) return cached;
  const resolved = entry.resolve(ctx, fnId);
  const perContext = RESOLVED.get(ctx) ?? new Map<string, FnOptions>();
  perContext.set(fnId, resolved);
  RESOLVED.set(ctx, perContext);
  return resolved;
}
