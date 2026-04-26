import {
  type Destination,
  factoryArgs,
  rcError,
  tagAdapter,
} from "@routecraft/routecraft";
import { parseProviderModel } from "../llm/shared.ts";
import { AgentDestinationAdapter } from "./destination.ts";
import { isToolSelection } from "./tools/selection.ts";
import type { AgentOptions, AgentResult } from "./types.ts";

/**
 * Validate the LLM-config shape of agent options. Run at construction so
 * misconfiguration surfaces immediately rather than at first dispatch.
 *
 * @internal
 */
export function validateAgentOptions(options: AgentOptions): void {
  if (typeof options.system !== "string" || options.system.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `Agent: "system" is required and must be a non-empty string.`,
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
 * @experimental
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
  arg: AgentOptions | string,
): Destination<unknown, AgentResult> {
  if (typeof arg === "string") {
    if (arg.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Agent: name must be a non-empty string.`,
      });
    }
    return tagAdapter(
      new AgentDestinationAdapter({ kind: "by-name", name: arg }),
      agent,
      factoryArgs(arg),
    );
  }
  validateAgentOptions(arg);
  return tagAdapter(
    new AgentDestinationAdapter({ kind: "inline", options: arg }),
    agent,
    factoryArgs(arg),
  );
}
