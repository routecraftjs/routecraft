import type { CraftContext, Tag } from "@routecraft/routecraft";
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
 * The kinds of underlying things `tools(...)` can wrap as a fn. Each
 * builder helper (`directTool`, `agentTool`, `mcpTool`) emits one of
 * these kinds; the kind is purely informational at runtime (used for
 * error messages and the prefix-auto-resolution path in `tools()`).
 *
 * @experimental
 */
export type DeferredFnKind = "direct" | "agent" | "mcp";

/**
 * A fn that cannot be fully constructed at config-write time because it
 * depends on registries (direct route metadata, agent registrations,
 * MCP tool descriptors) that aren't populated until later in the
 * context lifecycle.
 *
 * Created by the builder helpers; the `agentPlugin` stores deferred
 * entries unmodified, and the agent runtime calls `.resolve(ctx, id)`
 * just before building the LLM tool list, when all registries are live.
 *
 * @experimental
 */
export interface DeferredFn {
  readonly [DEFERRED_FN_BRAND]: true;
  /** Underlying source kind. Surfaces in error messages. */
  readonly kind: DeferredFnKind;
  /**
   * The underlying registered id this wrapper targets (route id for
   * `direct`, agent id for `agent`, `<server>:<tool>` for `mcp`). Used
   * by the `tools()` resolver for tag-selector dedup so a fn-registry
   * wrapper supersedes the same route surfaced via the prefix
   * convention.
   */
  readonly targetId: string;
  /**
   * Tags supplied as an explicit override at builder time (e.g.
   * `directTool(routeId, { tags: [...] })`). When present these take
   * precedence over the underlying registry's tags for tag-selector
   * matching, so the user's override actually drives selection.
   * Undefined when no override was supplied — the resolver then peeks
   * the underlying registry's tags for the match decision.
   */
  readonly overrideTags?: readonly Tag[];
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
 * emitted by `directTool` / `agentTool` / `mcpTool`.
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
 * as `FnOptions`; entries from `directTool` / `agentTool` / `mcpTool`
 * are stored as `DeferredFn` and resolved on first agent dispatch.
 *
 * @experimental
 */
export type FnEntry = FnOptions | DeferredFn;
