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
 * Single contribution to an agent's system context. Blocks unify
 * skills, memory, identity, instructions, and any future "stuff
 * injected into the system prompt" into one primitive.
 *
 * - `mode: "inject"` blocks are concatenated into the system prompt
 *   on every dispatch as `## <name>\n\n<content>`.
 * - `mode: "progressive"` blocks are exposed as a loader tool named
 *   `_block_load_<name>`; the description is shown to the model,
 *   and the body is fetched only when the model invokes the loader.
 */
export interface Block {
  /**
   * Identifier for the block. Unique within an agent's blocks list.
   * Must not start with the reserved `_block_` prefix that synthetic
   * loader tools use.
   */
  name: string;
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
