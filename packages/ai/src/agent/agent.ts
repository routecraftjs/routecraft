import {
  type Destination,
  factoryArgs,
  rcError,
  tagAdapter,
} from "@routecraft/routecraft";
import {
  BLOCK_LOADER_PREFIX,
  BLOCK_NAME_SEPARATOR,
  BLOCK_RESERVED_PREFIX,
  BLOCK_TOOL_NAME_CHARSET,
  blockCollisionError,
  blockCycleError,
  isBlockGroup,
  TOOL_NAME_MAX_LENGTH,
} from "../block/resolve.ts";
import type { BlockBody, Blocks } from "../block/types.ts";
import { parseProviderModel } from "../llm/shared.ts";
import {
  AgentDestinationAdapter,
  type AgentByNameOverrides,
} from "./destination.ts";
import { isToolSelection } from "./tools/selection.ts";
import type { AgentOptions, AgentResult } from "./types.ts";

/**
 * Validate the LLM-config shape of agent options. Run at construction so
 * misconfiguration surfaces immediately rather than at first dispatch.
 *
 * @internal
 */
export function validateAgentOptions(options: AgentOptions): void {
  // `system` accepts the same string-or-function shape as `llm({ system })`.
  // For the static form, require non-empty so misconfiguration ("" or
  // missing) surfaces at construction. The function form is validated at
  // dispatch (its return value flows through `resolvePrompt`).
  if (typeof options.system === "string") {
    if (options.system.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Agent: "system" is required and must be a non-empty string (or a function that returns one).`,
      });
    }
  } else if (typeof options.system !== "function") {
    throw rcError("RC5003", undefined, {
      message: `Agent: "system" must be a string or a function (exchange) => string.`,
    });
  }
  if (
    options.user !== undefined &&
    typeof options.user !== "string" &&
    typeof options.user !== "function"
  ) {
    throw rcError("RC5003", undefined, {
      message: `Agent: "user" must be a string or a function (exchange) => string when present.`,
    });
  }
  // `model` is optional: inheritable from agentPlugin({ defaultOptions:
  // { model } }) at dispatch time. Validate the shape only when present.
  if (options.model !== undefined) {
    if (typeof options.model !== "string" || options.model.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Agent: "model" must be a non-empty "providerId:modelName" string when present.`,
      });
    }
    try {
      parseProviderModel(options.model);
    } catch {
      throw rcError("RC5003", undefined, {
        message: `Agent: "model" string must be in "providerId:modelName" form (e.g. ollama:llama3). Got: "${options.model}"`,
      });
    }
  }
  if (options.tools !== undefined && !isToolSelection(options.tools)) {
    throw rcError("RC5003", undefined, {
      message: `Agent: "tools" must be the result of tools([...]).`,
    });
  }
  if (
    options.principal !== undefined &&
    typeof options.principal !== "boolean" &&
    typeof options.principal !== "function"
  ) {
    throw rcError("RC5003", undefined, {
      message: `Agent: "principal" must be a boolean or a function (principal, exchange) => string when present.`,
    });
  }
  if (options.output !== undefined) {
    if (options.output === null || typeof options.output !== "object") {
      throw rcError("RC5003", undefined, {
        message: `Agent: "output" must be a Standard Schema (Zod/Valibot/ArkType/etc.).`,
      });
    }
    const standard = (
      options.output as { ["~standard"]?: { validate?: unknown } }
    )["~standard"];
    if (typeof standard?.validate !== "function") {
      throw rcError("RC5003", undefined, {
        message: `Agent: "output" must be a Standard Schema (Zod/Valibot/ArkType/etc.).`,
      });
    }
  }
  if (options.blocks !== undefined) {
    validateBlocks(options.blocks);
  }
}

/**
 * Validate the shape of every entry on an agent's `blocks` record.
 * Throws RC5027 on individual block misconfiguration and RC5026 on
 * reserved-prefix collisions or empty names. Runs at construction so
 * misconfigured blocks surface immediately, not at first dispatch.
 *
 * Duplicate keys are impossible by construction (object literal); a
 * value of `false` is permitted and means "remove this block from
 * defaults" -- the validator only checks the body shape for non-`false`
 * entries. Empty-string keys are rejected because they round-trip as
 * an unloadable block name.
 *
 * Exported (`@internal`) so `agentPlugin({ defaultOptions: { blocks } })`
 * can reuse the same checks. Pass `defaultsLabel` from the defaults
 * path: it switches `false` from "allowed (per-agent removal sentinel)"
 * to "rejected with RC5003" at every nesting level, because defaults
 * cannot sensibly remove themselves, and names the offending entry
 * with that label.
 *
 * Validation is authoritative at construction: alongside the per-leaf
 * structural checks it enforces the flattened-name rules a synthetic
 * loader tool depends on (reserved `_block_` namespace, provider
 * charset and length, no two blocks collapsing to one name) so those
 * surface at `agent()` rather than at the provider on first dispatch.
 *
 * @internal
 */
export function validateBlocks(blocks: unknown, defaultsLabel?: string): void {
  const state: BlockValidationState = {
    seenNames: new Set<string>(),
    seenObjects: new WeakSet<object>(),
    // Only set when present: `exactOptionalPropertyTypes` forbids an
    // explicit `undefined` for the optional `defaultsLabel`.
    ...(defaultsLabel !== undefined ? { defaultsLabel } : {}),
  };
  validateBlocksLevel(blocks, "", state);
}

interface BlockValidationState {
  /** Flattened leaf names seen so far, for collision detection. */
  readonly seenNames: Set<string>;
  /** Groups on the current recursion path, for cycle detection. */
  readonly seenObjects: WeakSet<object>;
  /** Defaults label; when set, `false` is rejected (see {@link validateBlocks}). */
  readonly defaultsLabel?: string;
}

/**
 * Recursive worker for {@link validateBlocks}. Validates one level of a
 * {@link Blocks} tree, recursing into nested groups. `prefix` carries
 * the flattened-name path (joined by {@link BLOCK_NAME_SEPARATOR}) so
 * error messages name the offending block the way it resolves at
 * dispatch. A record value is a leaf or a nested group per {@link
 * isBlockGroup}.
 *
 * @internal
 */
function validateBlocksLevel(
  blocks: unknown,
  prefix: string,
  state: BlockValidationState,
): number {
  if (blocks === null || typeof blocks !== "object" || Array.isArray(blocks)) {
    throw rcError("RC5027", undefined, {
      message: `Agent: "blocks" must be a Record<string, BlockBody | Blocks | false>.`,
    });
  }
  if (state.seenObjects.has(blocks)) throw blockCycleError(prefix);
  state.seenObjects.add(blocks);
  // Count of leaves at this level and below. A nested group that
  // produces zero leaves (empty `{}` or only `false` members) is an
  // author mistake the strict-at-construction contract should surface,
  // so the caller rejects it; the top-level record is allowed to be
  // empty (an agent with no blocks).
  let leafCount = 0;
  for (const [name, body] of Object.entries(blocks as Blocks)) {
    const qualified = prefix ? `${prefix}${BLOCK_NAME_SEPARATOR}${name}` : name;
    if (name.trim() === "") {
      throw rcError("RC5026", undefined, {
        message: `Agent block: block name must be a non-empty string.`,
      });
    }
    // Reject reserved-prefix segments and any combination whose
    // flattened name lands in the reserved namespace (e.g. a group
    // "_block" with a leaf "x" flattens to "_block__x").
    if (
      name.startsWith(BLOCK_RESERVED_PREFIX) ||
      qualified.startsWith(BLOCK_RESERVED_PREFIX)
    ) {
      throw rcError("RC5026", undefined, {
        message: `Agent block "${qualified}": names starting with "${BLOCK_RESERVED_PREFIX}" are reserved for synthetic block tools. Rename the block or a parent group.`,
      });
    }
    if (body === false) {
      if (state.defaultsLabel !== undefined) {
        throw rcError("RC5003", undefined, {
          message:
            `agentPlugin: "${state.defaultsLabel}.${qualified}" cannot be false. ` +
            `"false" is the per-agent removal sentinel; defaults cannot remove themselves. ` +
            `Drop the entry or replace it with a BlockBody.`,
        });
      }
      continue;
    }
    if (body === null || typeof body !== "object") {
      throw rcError("RC5027", undefined, {
        message: `Agent block "${qualified}": value must be a BlockBody object (with mode and value), a nested Blocks group, or "false" to remove a default.`,
      });
    }
    if (isBlockGroup(body)) {
      // A value with no string `mode` is normally a nested group. But a
      // BlockBody-shaped `value` (string or function) is a strong signal
      // the author meant a leaf and forgot or mistyped `mode`; report
      // that precisely instead of recursing and blaming a phantom
      // `<name>__value` block. A real group's members are objects, so
      // this never misfires on a member that merely happens to be named
      // `value`.
      const maybeValue = (body as Partial<BlockBody>).value;
      if (typeof maybeValue === "string" || typeof maybeValue === "function") {
        throw rcError("RC5027", undefined, {
          message: `Agent block "${qualified}": "mode" must be "inject" or "progressive" (got ${JSON.stringify((body as Partial<BlockBody>).mode)}).`,
        });
      }
      const childLeaves = validateBlocksLevel(body, qualified, state);
      if (childLeaves === 0) {
        throw rcError("RC5027", undefined, {
          message: `Agent block "${qualified}": a nested group must contain at least one block (got an empty group or only "false" members).`,
        });
      }
      leafCount += childLeaves;
      continue;
    }
    if (state.seenNames.has(qualified)) throw blockCollisionError(qualified);
    state.seenNames.add(qualified);
    leafCount += 1;
    const b = body as BlockBody;
    if (b.mode !== "inject" && b.mode !== "progressive") {
      throw rcError("RC5027", undefined, {
        message: `Agent block "${qualified}": "mode" must be "inject" or "progressive" (got ${JSON.stringify(b.mode)}).`,
      });
    }
    if (
      b.mode === "progressive" &&
      (typeof b.description !== "string" || b.description.trim() === "")
    ) {
      throw rcError("RC5027", undefined, {
        message: `Agent block "${qualified}": progressive-mode blocks require a non-empty "description" so the model can decide whether to load.`,
      });
    }
    // Progressive blocks become the synthetic loader tool
    // `_block_load_<flattenedName>`, which the provider constrains to
    // `^[A-Za-z0-9_-]{1,64}$`. Check the flattened name here so an
    // unsafe or over-long name fails at construction, not at the
    // provider on first dispatch.
    if (b.mode === "progressive") {
      if (!BLOCK_TOOL_NAME_CHARSET.test(qualified)) {
        throw rcError("RC5027", undefined, {
          message: `Agent block "${qualified}": a progressive block becomes the loader tool "${BLOCK_LOADER_PREFIX}${qualified}", so its flattened name must match ${BLOCK_TOOL_NAME_CHARSET.source} (letters, digits, "_", "-"). Rename the block or its parent group.`,
        });
      }
      const toolName = `${BLOCK_LOADER_PREFIX}${qualified}`;
      if (toolName.length > TOOL_NAME_MAX_LENGTH) {
        throw rcError("RC5027", undefined, {
          message: `Agent block "${qualified}": the loader tool name "${toolName}" is ${toolName.length} characters, over the provider limit of ${TOOL_NAME_MAX_LENGTH}. Shorten the block name or its parent group.`,
        });
      }
    }
    if (
      b.lifetime !== undefined &&
      b.lifetime !== "dispatch" &&
      b.lifetime !== "context"
    ) {
      throw rcError("RC5027", undefined, {
        message: `Agent block "${qualified}": "lifetime" must be "dispatch" or "context" when present (got ${JSON.stringify(b.lifetime)}).`,
      });
    }
    if (typeof b.value !== "string" && typeof b.value !== "function") {
      throw rcError("RC5027", undefined, {
        message: `Agent block "${qualified}": "value" must be a string or a function returning a string.`,
      });
    }
  }
  state.seenObjects.delete(blocks);
  return leafCount;
}

/**
 * Create an agent destination.
 *
 * Two forms:
 *
 * - **Inline**: `agent({ model, system, user? })` -- destination constructed
 *   from inline options. Identity and description come from the enclosing
 *   route (`.id()`, `.description()`).
 * - **By name**: `agent("name")` -- destination resolved at dispatch time
 *   against agents registered via `agentPlugin({ agents: { name: {...} } })`.
 *   Registered agents carry their own description.
 *
 * @example Inline (identity on the route)
 * ```typescript
 * craft()
 *   .id("zoe")
 *   .description("A helpful assistant")
 *   .from(direct())
 *   .to(agent({
 *     model: "anthropic:claude-opus-4-7",
 *     system: readFileSync("./prompts/zoe.md", "utf-8"),
 *   }))
 *   .to(direct("reply"));
 * ```
 *
 * @example By name (agent registered in the plugin)
 * ```typescript
 * agentPlugin({
 *   agents: {
 *     summariser: {
 *       description: "Summarises documents",
 *       model: "anthropic:claude-opus-4-7",
 *       system: "Be concise.",
 *     },
 *   },
 * });
 *
 * craft()
 *   .id("caller")
 *   .from(timer({ intervalMs: 60_000 }))
 *   .to(agent("summariser"))
 *   .to(direct("reply"));
 * ```
 */
export function agent(options: AgentOptions): Destination<unknown, AgentResult>;
export function agent(name: string): Destination<unknown, AgentResult>;
export function agent(
  name: string,
  perCall: AgentByNameOverrides,
): Destination<unknown, AgentResult>;
export function agent(
  arg: AgentOptions | string,
  perCall?: AgentByNameOverrides,
): Destination<unknown, AgentResult> {
  if (typeof arg === "string") {
    if (arg.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Agent: name must be a non-empty string.`,
      });
    }
    return tagAdapter(
      new AgentDestinationAdapter({
        kind: "by-name",
        name: arg,
        ...(perCall ? { perCall } : {}),
      }),
      agent,
      // Preserve both args so `mockAdapter()` and other testing-hook
      // introspection see the per-call overrides supplied at the
      // call site (e.g. a per-request `onDelta`).
      perCall ? factoryArgs(arg, perCall) : factoryArgs(arg),
    );
  }
  validateAgentOptions(arg);
  return tagAdapter(
    new AgentDestinationAdapter({ kind: "inline", options: arg }),
    agent,
    factoryArgs(arg),
  );
}
