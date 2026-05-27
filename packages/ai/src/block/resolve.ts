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
 * (resolved tool names via `mergeUserAndLoaderTools`) with RC5026.
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
 * Throws RC5025 when an inject-mode resolver throws or returns a
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
  const entries = Object.entries(blocks).filter(
    (entry): entry is [string, BlockBody] => entry[1] !== false,
  );
  if (entries.length === 0) {
    return { systemAppend: "", loaderTools: [] };
  }
  const client = makeBlockClient(exchange);
  const parts: string[] = [];
  const loaderTools: BlockLoaderTool[] = [];
  for (const [name, body] of entries) {
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
 * Throws RC5025 on any failure so callers can decide whether to abort
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
    throw rcError("RC5027", undefined, {
      message: `Agent block "${name}": "value" must be a string or a function returning a string.`,
    });
  }
  if (!context) {
    throw rcError("RC5025", undefined, {
      message: `Agent block "${name}": resolver function requires a CraftContext but the exchange has no bound context.`,
    });
  }
  let resolved: unknown;
  try {
    resolved = await Promise.resolve(value(exchange, context, [], client));
  } catch (cause) {
    throw rcError("RC5025", cause, {
      message: `Agent block "${name}": resolver function threw: ${(cause as Error)?.message ?? String(cause)}`,
    });
  }
  if (typeof resolved !== "string") {
    throw rcError("RC5025", undefined, {
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
