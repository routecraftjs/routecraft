/**
 * The two controls a person sees, and the rules for changing them.
 *
 * Whoever writes the agent decides what may be changed about it, and the
 * default is that nothing can be. An agent file that names one model
 * advertises no model picker; one listing three advertises exactly those.
 * The same holds for the thinking level.
 *
 * One rule generalises both omissions: **an option with nothing to choose
 * is not advertised.** A select with a single entry is a control that
 * cannot do anything, and every editor renders it anyway.
 *
 * Which agent answers is not among these. A mount serves exactly one
 * agent, chosen by the harness the editor launched, so there is no choice
 * to offer and nothing to change. See the module JSDoc on `app.ts`.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  advertisedModels,
  advertisedReasoning,
  offersAChoice,
} from "../agent/advertised.ts";
import type { AgentSessionOverrides } from "../agent/session/types.ts";
import type { AgentRegisteredOptions } from "../agent/types.ts";

/** The config option ids this mount serves. */
export const CONFIG_MODEL = "model";
export const CONFIG_REASONING = "reasoning";

/** Every id, for telling an unknown one from a withheld one. */
const KNOWN_IDS = new Set<string>([CONFIG_MODEL, CONFIG_REASONING]);

/** Whether a config id is one this mount knows at all. */
export function isKnownConfigId(id: string): boolean {
  return KNOWN_IDS.has(id);
}

/** What the option builder needs to know about the session it describes. */
export interface ConfigOptionState {
  /** The agent this conversation belongs to, for its whole life. */
  readonly agent: string;
  /** Every agent the context holds, in registration order. */
  readonly agents: ReadonlyMap<string, AgentRegisteredOptions>;
  /** What the conversation has already chosen. */
  readonly overrides: AgentSessionOverrides | undefined;
}

/**
 * The complete set of options for a session, with their current values.
 *
 * This is what every answer carries: the protocol has no rejected-with-a-
 * reason response for a set, so a refusal is the unchanged list, and the
 * only way a client can tell what happened is by comparing.
 */
export function configOptionsFor(
  state: ConfigOptionState,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [];
  const registered = state.agents.get(state.agent);
  if (registered === undefined) return options;

  const models = advertisedModels(registered);
  if (offersAChoice(models)) {
    options.push({
      id: CONFIG_MODEL,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.overrides?.model ?? models[0]!,
      options: models.map((model) => ({ value: model, name: model })),
    });
  }

  const levels = advertisedReasoning(registered);
  if (offersAChoice(levels)) {
    options.push({
      id: CONFIG_REASONING,
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: state.overrides?.reasoning ?? levels[0]!,
      options: levels.map((level) => ({ value: level, name: level })),
    });
  }

  return options;
}

/** What a set was: applied, refused, or a request the mount cannot answer. */
export type ConfigOptionOutcome =
  | { readonly kind: "overrides"; readonly overrides: AgentSessionOverrides }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unknown" };

/**
 * Decide what `session/set_config_option` does, without doing it.
 *
 * Three of the four cases are here; the fourth (a session that is missing
 * or not the caller's) is answered before this is reached, because it must
 * answer identically to a session that does not exist.
 *
 * The refusals all return the complete unchanged list, which is how the
 * protocol says no:
 *
 * - a value outside the advertised list, which is a client bug worth a
 *   warn line;
 * - a known id this session does not advertise, because the agent file
 *   gave a scalar.
 *
 * An unknown id is a genuine error instead: a list would be a lie, because
 * there is nothing to report the current value of. `agent` arrives here as
 * an unknown id, which is the truthful answer: this mount has no such
 * option, because the harness already settled which agent answers.
 */
export function decideConfigOption(
  state: ConfigOptionState,
  configId: string,
  value: unknown,
): ConfigOptionOutcome {
  if (!isKnownConfigId(configId)) return { kind: "unknown" };
  const advertised = new Set(
    configOptionsFor(state).map((option) => option.id),
  );
  if (!advertised.has(configId)) {
    return {
      kind: "refused",
      reason: `this session does not advertise "${configId}"`,
    };
  }
  if (typeof value !== "string") {
    return {
      kind: "refused",
      reason: `"${configId}" takes one of its listed values`,
    };
  }

  const registered = state.agents.get(state.agent);
  if (registered === undefined) {
    return { kind: "refused", reason: `no agent named "${state.agent}"` };
  }
  if (configId === CONFIG_MODEL) {
    const offered = advertisedModels(registered);
    if (!isOffered(offered, value)) {
      return {
        kind: "refused",
        reason: `"${value}" is not one of the models this agent offers`,
      };
    }
    return { kind: "overrides", overrides: { model: value } };
  }
  const offered = advertisedReasoning(registered);
  if (!isOffered(offered, value)) {
    return {
      kind: "refused",
      reason: `"${value}" is not one of the thinking levels this agent offers`,
    };
  }
  return { kind: "overrides", overrides: { reasoning: value } };
}

/**
 * Whether a client's string is one the agent advertised.
 *
 * A predicate rather than a cast at the write, because the write is the
 * last place an unadvertised value could enter a stored record: `as never`
 * silences the compiler in both directions, so a later edit that moved the
 * guard would still compile.
 */
function isOffered<T extends string>(
  offered: readonly T[],
  value: string,
): value is T {
  return (offered as readonly string[]).includes(value);
}
