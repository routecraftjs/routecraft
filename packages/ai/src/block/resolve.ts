import {
  rcError,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FnOptions } from "../fn/types.ts";
import type { ResolvedTool } from "../agent/tools/selection.ts";
import { makeBlockClient } from "./client.ts";
import type {
  AgentBlockLoadSummary,
  BlockBody,
  BlockClient,
  Blocks,
} from "./types.ts";

/**
 * Separator joining nested {@link Blocks} group names into the single
 * canonical block name used for the system-prompt heading, the
 * synthetic loader tool name, and the `blocksLoaded` summary. A leaf
 * `onboarding` under group `skills` flattens to `skills__onboarding`.
 *
 * `__` rather than `/` because loader tool names reach the provider
 * unsanitised and must match `^[a-zA-Z0-9_-]{1,64}$`. Using one
 * canonical flattened name everywhere keeps the slice-based
 * {@link summariseBlockLoads} / {@link isBlockLoaderCall} logic intact.
 *
 * @internal
 */
export const BLOCK_NAME_SEPARATOR = "__";

/**
 * Symbol stamped on `ResolvedTool` entries produced by
 * {@link resolveBlocks} for `mode: "progressive"` blocks. Lets the
 * tool bridge route their telemetry to `agent:block:loaded` events
 * (and the session to partition them out of `AgentResult.toolCalls`)
 * without sniffing on the tool name.
 *
 * @internal
 */
export const BLOCK_LOADER_TOOL = Symbol.for("routecraft.ai.block.loader-tool");

/**
 * Reserved name prefix for the block surface. User tools (fns, direct
 * routes, MCP tools) and block names that start with this prefix
 * collide with the framework's synthetic surface and are rejected at
 * construction (block names via `validateBlocks`) or dispatch
 * (resolved tool names via `mergeUserAndLoaderTools`) with AI1002.
 *
 * The framework reserves the broader `_block_` namespace (not just
 * `_block_load_`) so future synthetic-tool kinds (e.g. unloaders or
 * state probes) can land without a separate breaking reservation.
 *
 * @internal
 */
export const BLOCK_RESERVED_PREFIX = "_block_";

/**
 * Concrete prefix used to generate synthetic loader-tool names today.
 * Always starts with {@link BLOCK_RESERVED_PREFIX}; user names are
 * validated against the broader reservation, not this specific kind.
 *
 * @internal
 */
export const BLOCK_LOADER_PREFIX = "_block_load_";

/**
 * Internal extension carried on a synthetic loader-tool `ResolvedTool`.
 * The session reads it to assemble `AgentResult.blocksLoaded` after a
 * dispatch.
 *
 * @internal
 */
export interface BlockLoaderToolMeta {
  [BLOCK_LOADER_TOOL]: true;
  blockName: string;
}

/** A `ResolvedTool` known to be a synthetic block loader. @internal */
export type BlockLoaderTool = ResolvedTool & BlockLoaderToolMeta;

/**
 * Type guard for {@link BlockLoaderTool}. Used by the session and tool
 * bridge to differentiate user tools from framework-synthesised loaders.
 *
 * @internal
 */
export function isBlockLoaderTool(tool: ResolvedTool): tool is BlockLoaderTool {
  return (tool as { [BLOCK_LOADER_TOOL]?: true })[BLOCK_LOADER_TOOL] === true;
}

/**
 * Result of resolving a list of {@link Block}s for one agent dispatch.
 * `systemAppend` is the string to concatenate onto the agent's
 * `system` prompt (already includes per-block `## <name>` headings).
 * `loaderTools` is the list of synthetic tools to merge into the
 * agent's `ResolvedTool[]` before handing it to the LLM.
 *
 * @internal
 */
export interface ResolvedBlocks {
  systemAppend: string;
  loaderTools: BlockLoaderTool[];
}

/**
 * Resolve every block on an agent for one dispatch.
 *
 * - `mode: "inject"` blocks: run the resolver (respecting `lifetime`)
 *   and append the result to `systemAppend` as `## <name>\n\n<body>`.
 * - `mode: "progressive"` blocks: emit one synthetic
 *   `_block_load_<name>` tool whose handler runs the resolver on
 *   demand against the captured exchange and context.
 *
 * Caching for `lifetime: "context"` is keyed by the block object
 * identity on a `WeakMap<CraftContext, Map<Block, string>>`. Two
 * declarations of the same logical block in separate agents are
 * therefore independent caches.
 *
 * Throws AI1001 when an inject-mode resolver throws or returns a
 * non-string. Progressive-mode resolver failures surface back to the
 * model as a loader-tool error so the model can self-correct rather
 * than aborting the dispatch.
 *
 * @internal
 */
export async function resolveBlocks(
  blocks: Blocks | undefined,
  exchange: Exchange<unknown>,
  context: CraftContext | undefined,
): Promise<ResolvedBlocks> {
  if (!blocks) return { systemAppend: "", loaderTools: [] };
  const flat = flattenBlocks(blocks);
  if (flat.size === 0) {
    return { systemAppend: "", loaderTools: [] };
  }
  const client = makeBlockClient(exchange);
  const parts: string[] = [];
  const loaderTools: BlockLoaderTool[] = [];
  for (const [name, body] of flat) {
    if (body.mode === "inject") {
      const value = await resolveOnce(name, body, exchange, context, client);
      parts.push(`\n\n## ${name}\n\n${value}`);
      continue;
    }
    loaderTools.push(buildLoaderTool(name, body, exchange, context, client));
  }
  return { systemAppend: parts.join(""), loaderTools };
}

/**
 * Discriminate a {@link Blocks} record value: a leaf {@link BlockBody}
 * carries a string `mode` (always `"inject"` or `"progressive"`); any
 * other object value is a nested group. Keying on `mode` being a
 * string is unambiguous for well-formed input because a group's
 * members are always objects (`BlockBody`/`Blocks`) or `false`, never a
 * bare string, so a group can never accidentally present a string
 * `mode` at its own level, even when a member happens to be named
 * `mode`. A malformed leaf that omits `mode` is caught separately by
 * `validateBlocks` (which reports the missing mode) rather than being
 * silently treated as a group. `false` removal sentinels are filtered
 * out before this is called.
 *
 * @internal
 */
export function isBlockGroup(value: BlockBody | Blocks): value is Blocks {
  return typeof (value as Partial<BlockBody>).mode !== "string";
}

/**
 * Provider tool-name charset. Synthetic loader names are
 * `_block_load_<flattenedName>` and are sent to the model provider
 * verbatim, which constrains them to `^[A-Za-z0-9_-]{1,64}$`. The
 * flattened block name must therefore satisfy {@link
 * BLOCK_TOOL_NAME_CHARSET} and stay within {@link TOOL_NAME_MAX_LENGTH}
 * once the loader prefix is added. Validated at construction so an
 * unsafe name fails at `agent()` rather than at the provider on the
 * first dispatch.
 *
 * @internal
 */
export const BLOCK_TOOL_NAME_CHARSET = /^[A-Za-z0-9_-]+$/;

/** Maximum provider tool-name length. @internal */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * AI1002 error for two blocks whose names collapse to the same
 * flattened canonical name. Shared by the construction-time validator
 * ({@link validateBlocks}) and the dispatch-time flattener ({@link
 * flattenBlocks}) so the code and message cannot drift between the two
 * walkers, which must stay behaviourally identical.
 *
 * @internal
 */
export function blockCollisionError(
  qualified: string,
): ReturnType<typeof rcError> {
  return rcError("AI1002", undefined, {
    message: `Agent block "${qualified}": two blocks resolve to the same name after flattening nested groups. Rename one of them.`,
  });
}

/**
 * AI1002 error for a blocks tree that contains a cycle (a group that
 * directly or transitively contains itself). Shared by the validator
 * and the flattener for the same reason as {@link blockCollisionError}.
 *
 * @internal
 */
export function blockCycleError(prefix: string): ReturnType<typeof rcError> {
  return rcError("AI1002", undefined, {
    message: `Agent block "${prefix}": blocks form a cycle (a group contains itself). Block trees must be finite.`,
  });
}

/**
 * Flatten a {@link Blocks} tree depth-first into an ordered map keyed
 * by the canonical name (group names joined by {@link
 * BLOCK_NAME_SEPARATOR}). Insertion order is preserved so inject
 * blocks keep their author-declared system-prompt order. `false`
 * entries are skipped (they are removal sentinels handled at merge
 * time, a no-op here). Two blocks that collapse to the same flattened
 * name throw AI1002 so a silent override cannot happen. This runs on
 * the post-merge record at dispatch, so it is the authoritative guard
 * for collisions that only arise once defaults and per-agent blocks
 * are combined; within-record collisions are already caught earlier by
 * `validateBlocks` at construction.
 *
 * @internal
 */
export function flattenBlocks(blocks: Blocks): Map<string, BlockBody> {
  const out = new Map<string, BlockBody>();
  walkBlocks(blocks, "", out, new WeakSet());
  return out;
}

function walkBlocks(
  blocks: Blocks,
  prefix: string,
  out: Map<string, BlockBody>,
  // Ancestors on the current recursion path; guards against a group
  // that (directly or transitively) contains itself, which would
  // otherwise recurse without bound. Added before descending and
  // removed after, so a group legitimately reused on two sibling
  // branches is not mistaken for a cycle.
  seen: WeakSet<object>,
): void {
  if (seen.has(blocks)) throw blockCycleError(prefix);
  seen.add(blocks);
  for (const [name, body] of Object.entries(blocks)) {
    if (body === false) continue;
    const qualified = prefix ? `${prefix}${BLOCK_NAME_SEPARATOR}${name}` : name;
    if (isBlockGroup(body)) {
      walkBlocks(body, qualified, out, seen);
      continue;
    }
    if (out.has(qualified)) throw blockCollisionError(qualified);
    out.set(qualified, body);
  }
  seen.delete(blocks);
}

/**
 * Per-context, per-block resolution cache. Keyed by `CraftContext`
 * identity at the outer layer and by `BlockBody` object identity at
 * the inner layer. Stores the in-flight promise rather than the
 * resolved string so concurrent dispatches against the same
 * `context`-lifetime block share one resolution instead of racing
 * into N parallel invocations. WeakMap on the outer key so a disposed
 * context does not pin block content in memory.
 *
 * @internal
 */
const LIFETIME_CACHE = new WeakMap<
  CraftContext,
  Map<BlockBody, Promise<string>>
>();

/**
 * Run a block's resolver, honouring `lifetime`. For
 * `lifetime: "dispatch"` (default) the resolver runs every call. For
 * `lifetime: "context"` the resolver runs once per `CraftContext`
 * and the cached value (or in-flight promise) is reused for
 * subsequent calls in that context.
 *
 * @internal
 */
async function resolveOnce(
  name: string,
  body: BlockBody,
  exchange: Exchange<unknown>,
  context: CraftContext | undefined,
  client: BlockClient,
): Promise<string> {
  const lifetime = body.lifetime ?? "dispatch";
  if (lifetime === "context" && context) {
    let cache = LIFETIME_CACHE.get(context);
    if (cache?.has(body)) return cache.get(body) as Promise<string>;
    if (!cache) {
      cache = new Map<BlockBody, Promise<string>>();
      LIFETIME_CACHE.set(context, cache);
    }
    const pending = invokeResolver(name, body, exchange, context, client);
    cache.set(body, pending);
    // On rejection, evict so a subsequent dispatch can retry rather
    // than being permanently stuck on the cached failure.
    pending.catch(() => cache!.delete(body));
    return pending;
  }
  return invokeResolver(name, body, exchange, context, client);
}

/**
 * Invoke a block's `value` resolver and validate its return shape.
 * Throws AI1001 on any failure so callers can decide whether to abort
 * the dispatch (inject mode) or report the error back to the model
 * (progressive mode).
 *
 * @internal
 */
async function invokeResolver(
  name: string,
  body: BlockBody,
  exchange: Exchange<unknown>,
  context: CraftContext | undefined,
  client: BlockClient,
): Promise<string> {
  const { value } = body;
  if (typeof value === "string") return value;
  if (typeof value !== "function") {
    throw rcError("AI1003", undefined, {
      message: `Agent block "${name}": "value" must be a string or a function returning a string.`,
    });
  }
  if (!context) {
    throw rcError("AI1001", undefined, {
      message: `Agent block "${name}": resolver function requires a CraftContext but the exchange has no bound context.`,
    });
  }
  let resolved: unknown;
  try {
    resolved = await Promise.resolve(value(exchange, context, [], client));
  } catch (cause) {
    throw rcError("AI1001", cause, {
      message: `Agent block "${name}": resolver function threw: ${(cause as Error)?.message ?? String(cause)}`,
    });
  }
  if (typeof resolved !== "string") {
    throw rcError("AI1001", undefined, {
      message: `Agent block "${name}": resolver function must return a string (got ${typeof resolved}).`,
    });
  }
  return resolved;
}

/**
 * JSON Schema describing an empty object. The loader tools accept no
 * input from the model (the block's content is fixed by the resolver,
 * not parameterised), so the schema is closed for additional properties
 * to match the bridge's expectations.
 *
 * @internal
 */
const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

/**
 * Standard Schema implementation of an empty input object for loader
 * tools. Mirrors the shape used by `currentTime` / `randomUuid` so the
 * AI SDK bridge's JSON-schema lookup works uniformly.
 *
 * @internal
 */
const EMPTY_OBJECT_SCHEMA: StandardSchemaV1<unknown, Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value as object).length > 0
      ) {
        return {
          issues: [{ message: "Expected an empty object {}." }],
        };
      }
      return { value: {} as Record<string, never> };
    },
    jsonSchema: {
      input: () => EMPTY_OBJECT_JSON_SCHEMA,
      output: () => EMPTY_OBJECT_JSON_SCHEMA,
    },
  } as StandardSchemaV1<unknown, Record<string, never>>["~standard"],
};

/**
 * Build the synthetic `_block_load_<name>` tool for a progressive
 * block. The handler closes over the dispatch's exchange / context /
 * client so the resolver runs against live per-dispatch state when
 * the model invokes the loader. Errors are rethrown so the standard
 * tool-bridge error path reports them as a tool error the model can
 * self-correct from.
 *
 * @internal
 */
function buildLoaderTool(
  name: string,
  body: BlockBody,
  exchange: Exchange<unknown>,
  context: CraftContext | undefined,
  client: BlockClient,
): BlockLoaderTool {
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description
      : `Load the "${name}" block.`;
  const handler: FnOptions["handler"] = async () =>
    resolveOnce(name, body, exchange, context, client);
  return {
    name: `${BLOCK_LOADER_PREFIX}${name}`,
    description,
    input: EMPTY_OBJECT_SCHEMA,
    handler,
    [BLOCK_LOADER_TOOL]: true,
    blockName: name,
  };
}

/**
 * Build the `AgentBlockLoadSummary[]` from accumulated tool calls.
 * Filters the dispatched tool-call list to entries whose name carries
 * the reserved loader prefix and maps them onto the public summary
 * shape consumed by `AgentResult.blocksLoaded`.
 *
 * @internal
 */
export function summariseBlockLoads(
  toolCalls: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    output?: unknown;
    error?: unknown;
  }>,
): AgentBlockLoadSummary[] {
  const out: AgentBlockLoadSummary[] = [];
  for (const tc of toolCalls) {
    if (!tc.toolName.startsWith(BLOCK_LOADER_PREFIX)) continue;
    const blockName = tc.toolName.slice(BLOCK_LOADER_PREFIX.length);
    const summary: AgentBlockLoadSummary = {
      blockName,
      toolName: tc.toolName,
      toolCallId: tc.toolCallId,
    };
    if (tc.output !== undefined) summary.output = tc.output;
    if (tc.error !== undefined) summary.error = tc.error;
    out.push(summary);
  }
  return out;
}

/**
 * Predicate matching the tool-call summaries that came from synthetic
 * block loaders. Used by the session to partition the cumulative
 * tool-call list before populating `AgentResult.toolCalls` vs
 * `AgentResult.blocksLoaded`.
 *
 * @internal
 */
export function isBlockLoaderCall(toolName: string): boolean {
  return toolName.startsWith(BLOCK_LOADER_PREFIX);
}
