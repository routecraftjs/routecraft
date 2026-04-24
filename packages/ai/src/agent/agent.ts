import {
  type Destination,
  factoryArgs,
  rcError,
  tagAdapter,
} from "@routecraft/routecraft";
import { parseProviderModel } from "../llm/shared.ts";
import { AgentDestinationAdapter } from "./destination.ts";
import {
  AGENT_REGISTRATION_BRAND,
  type AgentOptions,
  type AgentRegisteredOptions,
  type AgentRegistration,
  type AgentResult,
} from "./types.ts";

/**
 * Validate the LLM-config shape shared by inline and registered agents.
 * Run at construction so misconfiguration surfaces immediately rather
 * than at first dispatch.
 */
function validateAgentOptions(options: AgentOptions): void {
  if (typeof options.system !== "string" || options.system.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `Agent: "system" is required and must be a non-empty string.`,
    });
  }
  if (typeof options.model === "string") {
    try {
      parseProviderModel(options.model);
    } catch {
      throw rcError("RC5003", undefined, {
        message: `Agent: "model" string must be in "providerId:modelName" form (e.g. ollama:llama3). Got: "${options.model}"`,
      });
    }
  } else if (
    options.model === null ||
    typeof options.model !== "object" ||
    typeof (options.model as { provider?: unknown }).provider !== "string"
  ) {
    throw rcError("RC5003", undefined, {
      message: `Agent: "model" must be either a "providerId:modelName" string or an LlmModelConfig object with a "provider" field.`,
    });
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
 *   against agents registered via `agentPlugin({ agents: [defineAgent({...})] })`.
 *   Registered agents carry their own id and description.
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
 *   agents: [defineAgent({
 *     id: "summariser",
 *     description: "Summarises documents",
 *     model: "anthropic:claude-opus-4-7",
 *     system: "Be concise.",
 *   })],
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

/**
 * Define a registerable agent. Pass the result to
 * `agentPlugin({ agents: [defineAgent(...)] })` to make it resolvable via
 * `agent("id")` from any route in the context.
 *
 * Id and description are required on registrations because there is no
 * enclosing route to inherit them from.
 *
 * @experimental
 */
export function defineAgent(
  options: AgentRegisteredOptions,
): AgentRegistration {
  if (typeof options.id !== "string" || options.id.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `defineAgent: "id" is required and must be a non-empty string.`,
    });
  }
  if (
    typeof options.description !== "string" ||
    options.description.trim() === ""
  ) {
    throw rcError("RC5003", undefined, {
      message:
        `defineAgent: "description" is required and must be a non-empty string. ` +
        `Registered agents carry their own description because they are not ` +
        `backed by a route.`,
    });
  }
  validateAgentOptions(options);
  return Object.freeze({
    [AGENT_REGISTRATION_BRAND]: true,
    options: { ...options },
  }) as AgentRegistration;
}
