/**
 * What an agent offers a caller a choice about, and what a caller's stored
 * choice resolves to.
 *
 * Whoever writes the agent decides what may be changed about it, and the
 * default is that nothing can be. An agent that names one model and one
 * thinking level advertises no choice at all; one whose file lists several
 * advertises exactly those and never anything else. This module is the one
 * place that rule is expressed, so the protocol surface that renders the
 * choices, the write that stores one, and the turn that applies it cannot
 * disagree about what "offered" means.
 */

import { rcError } from "@routecraft/routecraft";
import type { LlmModelId, LlmReasoningEffort } from "../llm/types.ts";
import type { AgentSessionOverrides } from "./session/types.ts";

/**
 * The minimum an agent has to expose for its choices to be read. Narrower
 * than `AgentRegisteredOptions` so a caller holding merged options, or a
 * test, can ask the same question without building a whole agent.
 */
export interface AdvertisingAgent {
  readonly model?: LlmModelId;
  readonly models?: readonly LlmModelId[];
  readonly reasoning?: LlmReasoningEffort;
  readonly reasoningLevels?: readonly LlmReasoningEffort[];
}

/**
 * The models this agent offers, in the order a chooser shows them.
 *
 * An agent with a list offers that list. An agent with only a `model`
 * offers that one value, which is a list of one and therefore no choice.
 * An agent with neither offers nothing: its model comes from
 * `agentPlugin({ defaultOptions })` at dispatch, and a context default is
 * not the agent's to give away.
 */
export function advertisedModels(
  agent: AdvertisingAgent,
): readonly LlmModelId[] {
  if (agent.models !== undefined) return agent.models;
  return agent.model === undefined ? [] : [agent.model];
}

/** The thinking levels this agent offers. See {@link advertisedModels}. */
export function advertisedReasoning(
  agent: AdvertisingAgent,
): readonly LlmReasoningEffort[] {
  if (agent.reasoningLevels !== undefined) return agent.reasoningLevels;
  return agent.reasoning === undefined ? [] : [agent.reasoning];
}

/**
 * Whether a list is worth putting in front of a person.
 *
 * A control with nothing to choose is not a control, and every editor
 * renders one anyway, so the omission happens here rather than in each
 * caller's own conditional.
 */
export function offersAChoice(values: readonly unknown[]): boolean {
  return values.length > 1;
}

/**
 * Check a registered agent's own lists at context init.
 *
 * The two ways a list can be built (an agent file's `model: [a, b]`, and
 * an `agents()` override supplying `models` on its own) can disagree about
 * which entry is the default, and a default outside its own list would
 * render as a chooser whose current value is not among its options.
 *
 * @throws RC5003 when a list is empty, or when the default is not in it
 */
export function validateAdvertisedChoices(
  label: string,
  agent: AdvertisingAgent,
): void {
  if (agent.models !== undefined) {
    assertList(label, "models", "model", agent.models, agent.model);
  }
  if (agent.reasoningLevels !== undefined) {
    assertList(
      label,
      "reasoningLevels",
      "reasoning",
      agent.reasoningLevels,
      agent.reasoning,
    );
  }
}

function assertList(
  label: string,
  listField: string,
  defaultField: string,
  values: readonly string[],
  current: string | undefined,
): void {
  if (values.length === 0) {
    throw rcError("RC5003", undefined, {
      message: `${label}: "${listField}" is empty. Remove it, or list at least one value.`,
    });
  }
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `${label}: "${listField}" must contain only non-empty strings.`,
      });
    }
  }
  if (current === undefined) {
    throw rcError("RC5003", undefined, {
      message: `${label}: "${listField}" is set but "${defaultField}" is not, so the agent offers choices with no default among them. Set "${defaultField}" to the entry it should run on.`,
    });
  }
  if (!values.includes(current)) {
    throw rcError("RC5003", undefined, {
      message: `${label}: "${defaultField}" is "${current}", which is not one of "${listField}" (${values.join(", ")}). The default an agent runs on has to be one of the values it offers.`,
    });
  }
}

/**
 * Refuse a choice the agent never offered, before it is stored.
 *
 * This is the last place a value that was never advertised could enter the
 * system: nothing downstream re-checks, because a stored record is trusted
 * to hold only what passed here.
 *
 * @throws AI1017 when a value is outside the agent's advertised list
 */
export function assertOverridesAdvertised(
  agentName: string,
  agent: AdvertisingAgent,
  overrides: AgentSessionOverrides,
): void {
  if (overrides.model !== undefined) {
    assertOffered(agentName, "model", overrides.model, advertisedModels(agent));
  }
  if (overrides.reasoning !== undefined) {
    assertOffered(
      agentName,
      "reasoning",
      overrides.reasoning,
      advertisedReasoning(agent),
    );
  }
}

function assertOffered(
  agentName: string,
  field: string,
  value: string,
  offered: readonly string[],
): void {
  if (offered.includes(value)) return;
  throw rcError("AI1017", undefined, {
    message: `Agent "${agentName}" does not offer "${value}" as a "${field}". It offers ${
      offered.length === 0
        ? "nothing for that setting"
        : offered.map((entry) => `"${entry}"`).join(", ")
    }.`,
  });
}

/**
 * The model and thinking level a turn runs on, given the agent's options
 * and whatever the conversation chose.
 *
 * An override outside the advertised list is ignored rather than obeyed.
 * It cannot be written in the first place, so reaching this branch means
 * the agent file changed under a record that was valid when it was stored,
 * and running a model the agent no longer offers is the one outcome
 * nobody asked for.
 */
export function applyOverrides<T extends AdvertisingAgent>(
  agent: T,
  overrides: AgentSessionOverrides | undefined,
): T {
  if (overrides === undefined) return agent;
  const model =
    overrides.model !== undefined &&
    advertisedModels(agent).includes(overrides.model)
      ? overrides.model
      : undefined;
  const reasoning =
    overrides.reasoning !== undefined &&
    advertisedReasoning(agent).includes(overrides.reasoning)
      ? overrides.reasoning
      : undefined;
  if (model === undefined && reasoning === undefined) return agent;
  return {
    ...agent,
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
