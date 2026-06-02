import type { CraftContext, Exchange, ForwardFn } from "@routecraft/routecraft";

/**
 * Whether a block's content is always concatenated into the system
 * prompt ("inject") or surfaced as a loader tool the model invokes on
 * demand ("progressive"). Progressive disclosure matches Claude Code's
 * default: the block's name + description goes into the system prompt
 * via tool discovery, and the body is only fetched when the model
 * decides it's relevant.
 */
export type BlockMode = "inject" | "progressive";

/**
 * Lifetime of a resolved block value.
 *
 * - `"dispatch"` (default): the resolver runs every time the agent
 *   dispatches.
 * - `"context"`: the resolver runs once per `CraftContext` and the
 *   returned string is reused for every subsequent dispatch in that
 *   context. The cache key is the block's object identity, so two
 *   declarations of the same logical block in separate agents are
 *   independent caches.
 *
 * Naming reflects the actual semantic (how long the resolved value
 * lives) rather than the prior `cache: "every-call" | "once"` shape,
 * whose default did not actually cache anything.
 */
export type BlockLifetime = "dispatch" | "context";

/**
 * Helper handed to a block resolver function. Wraps the same
 * {@link ForwardFn} that route `.error()` handlers receive so a
 * resolver can delegate to a named route via
 * `client.forward("memory:get", payload)`.
 */
export interface BlockClient {
  /**
   * Forward a payload to a registered direct endpoint and return the
   * resulting exchange body. Identical semantics to the `forward`
   * callable handed to route-level `.error()` handlers.
   */
  readonly forward: ForwardFn;
}

/**
 * Resolves a block's content for a dispatch. Either a static string
 * (used verbatim) or a function evaluated when the block is needed.
 *
 * The `events` parameter is reserved for a forthcoming
 * exchange-event-log feature and is always `[]` today. The signature
 * carries it now so existing resolvers do not need to be rewritten
 * when events become populated.
 */
export type BlockResolver =
  | string
  | ((
      exchange: Exchange<unknown>,
      context: CraftContext,
      events: readonly unknown[],
      client: BlockClient,
    ) => string | Promise<string>);

/**
 * Body of a single block. Stored as the value side of an
 * {@link Blocks} record; the block's name is the record key, not a
 * field on this object.
 *
 * - `mode: "inject"` blocks are concatenated into the system prompt
 *   on every dispatch as `## <name>\n\n<content>`.
 * - `mode: "progressive"` blocks are exposed as a loader tool named
 *   `_block_load_<name>`; the description is shown to the model,
 *   and the body is fetched only when the model invokes the loader.
 *
 * A `BlockBody` is the leaf of a {@link Blocks} tree. A record value
 * is treated as a leaf when it carries a string `mode`; any other
 * record value is a nested group (see {@link Blocks}).
 */
export interface BlockBody {
  /**
   * Human-readable description. Required when `mode === "progressive"`
   * so the model can decide whether to load the block. Ignored for
   * `mode === "inject"` blocks.
   */
  description?: string;
  /**
   * Whether the block contributes to every system prompt or is loaded
   * on demand via a synthetic tool call. See {@link BlockMode}.
   */
  mode: BlockMode;
  /**
   * How long a resolved block value lives before it is recomputed.
   * Defaults to `"dispatch"`. See {@link BlockLifetime}.
   */
  lifetime?: BlockLifetime;
  /**
   * Resolver: a static string used verbatim, or a function returning
   * the string. See {@link BlockResolver}.
   */
  value: BlockResolver;
}

/**
 * Record of block contributions to an agent's system context. Keys
 * are block names (must not start with the reserved `_block_` prefix
 * used by synthetic loader tools). Setting a name to `false` removes
 * the block from defaults inherited via `agentPlugin({ defaultOptions
 * { blocks } })`; a `false` for a name that isn't in defaults is a
 * no-op (no validation error so adding/removing defaults later cannot
 * silently break agents).
 *
 * A value may be either a single {@link BlockBody} (a leaf) or a
 * nested `Blocks` record (a group). Groups let a named collection,
 * such as the skills returned by {@link skills}, stay grouped under
 * one key instead of dissolving into the top-level namespace:
 *
 * ```ts
 * blocks: {
 *   skills: await skills({ source: "./skills" }), // a named group
 *   tone:   { mode: "inject", value: "..." },      // a single block
 * }
 * ```
 *
 * Groups flatten at resolution time into a single canonical name
 * joined by `__` (see `BLOCK_NAME_SEPARATOR`): a leaf `onboarding`
 * under group `skills` resolves to `skills__onboarding` for its system
 * prompt heading, loader tool name, and `blocksLoaded` summary. `__`
 * (not `/`) is used because loader tool names reach the provider
 * unsanitised and must match `^[a-zA-Z0-9_-]{1,64}$`.
 *
 * A leaf is distinguished from a group at runtime by the presence of a
 * string `mode` field; any other object value is a nested group.
 */
export type Blocks = { [name: string]: BlockBody | Blocks | false };

/**
 * Summary of one progressive-mode block that the model loaded during
 * a dispatch. Populated only when the model actually invoked the
 * loader tool; inject-mode blocks never appear here because they
 * always contribute to the system prompt.
 */
export interface AgentBlockLoadSummary {
  /** Name of the block. */
  blockName: string;
  /** Loader tool name (`_block_load_<blockName>`). */
  toolName: string;
  /** Stable id assigned by the SDK to correlate invoked → result. */
  toolCallId: string;
  /** Resolved content returned to the model. Undefined when the loader errored. */
  output?: unknown;
  /** Thrown value when resolution failed. Undefined on success. */
  error?: unknown;
}
