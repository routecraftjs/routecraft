/**
 * The three controls a person sees, and the rules for changing them.
 *
 * Whoever writes the persona decides what may be changed about it, and the
 * default is that nothing can be. An agent file that names one model
 * advertises no model picker; one listing three advertises exactly those.
 * The same holds for the thinking level, and for the persona itself when
 * the context holds one agent.
 *
 * One rule generalises all three omissions: **an option with nothing to
 * choose is not advertised.** A select with a single entry is a control
 * that cannot do anything, and every editor renders it anyway.
 */

import type {
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  advertisedModels,
  advertisedReasoning,
  offersAChoice,
} from "../agent/advertised.ts";
import type { AgentSessionOverrides } from "../agent/session/types.ts";
import type { AgentRegisteredOptions } from "../agent/types.ts";

/** The config option ids this mount serves. */
export const CONFIG_AGENT = "agent";
export const CONFIG_MODEL = "model";
export const CONFIG_REASONING = "reasoning";

/** Every id, for telling an unknown one from a withheld one. */
const KNOWN_IDS = new Set<string>([
  CONFIG_AGENT,
  CONFIG_MODEL,
  CONFIG_REASONING,
]);

/** Whether a config id is one this mount knows at all. */
export function isKnownConfigId(id: string): boolean {
  return KNOWN_IDS.has(id);
}

/** What the option builder needs to know about the session it describes. */
export interface ConfigOptionState {
  /** The agent this conversation is talking to. */
  readonly agent: string;
  /** Every agent the context holds, in registration order. */
  readonly agents: ReadonlyMap<string, AgentRegisteredOptions>;
  /** Completed turns, which is what fixes the persona. */
  readonly turns: number;
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

  const personas = [...state.agents.entries()];
  if (offersAChoice(personas)) {
    options.push({
      id: CONFIG_AGENT,
      name: "Agent",
      category: "mode",
      type: "select",
      currentValue: state.agent,
      options: personas.map(([name, entry]) => ({
        value: name,
        name,
        ...(entry.description !== undefined
          ? { description: entry.description }
          : {}),
      })),
    });
  }

  if (registered !== undefined) {
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
  }

  return options;
}

/**
 * The superseded modes API, provided alongside the config options for the
 * transition the spec asks for.
 *
 * Modes carry the persona, which is the one axis that had a home under the
 * old API. A context with one agent has no modes to offer, and returns
 * nothing rather than a list of one.
 */
export function modesFor(
  state: ConfigOptionState,
): SessionModeState | undefined {
  const personas = [...state.agents.entries()];
  if (!offersAChoice(personas)) return undefined;
  return {
    currentModeId: state.agent,
    availableModes: personas.map(([name, entry]) => ({
      id: name,
      name,
      ...(entry.description !== undefined
        ? { description: entry.description }
        : {}),
    })),
  };
}

/** What a set was: applied, refused, or a request the mount cannot answer. */
export type ConfigOptionOutcome =
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "overrides"; readonly overrides: AgentSessionOverrides }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unknown" };

/**
 * Decide what `session/set_config_option` does, without doing it.
 *
 * Five of the six cases are here; the sixth (a session that is missing or
 * not the caller's) is answered before this is reached, because it must
 * answer identically to a session that does not exist.
 *
 * The four refusals all return the complete unchanged list, which is how
 * the protocol says no:
 *
 * - the persona, changed after the first turn: the session key includes
 *   the agent, so an early change re-keys an empty record and a late one
 *   cannot be honoured;
 * - the persona, changed while a turn is running, by the same rule, since
 *   a running turn means the turn count is about to be non-zero;
 * - a value outside the advertised list, which is a client bug worth a
 *   warn line;
 * - a known id this session does not advertise, because the agent file
 *   gave a scalar.
 *
 * An unknown id is a genuine error instead: a list would be a lie, because
 * there is nothing to report the current value of.
 */
export function decideConfigOption(
  state: ConfigOptionState,
  running: boolean,
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

  if (configId === CONFIG_AGENT) {
    if (state.turns > 0 || running) {
      return {
        kind: "refused",
        reason:
          "the conversation has already started, and talking to a different persona is a new conversation",
      };
    }
    if (!state.agents.has(value)) {
      return { kind: "refused", reason: `no agent named "${value}"` };
    }
    return { kind: "agent", agent: value };
  }

  const registered = state.agents.get(state.agent);
  if (registered === undefined) {
    return { kind: "refused", reason: `no agent named "${state.agent}"` };
  }
  if (configId === CONFIG_MODEL) {
    if (!advertisedModels(registered).includes(value as never)) {
      return {
        kind: "refused",
        reason: `"${value}" is not one of the models this agent offers`,
      };
    }
    return { kind: "overrides", overrides: { model: value as never } };
  }
  if (!advertisedReasoning(registered).includes(value as never)) {
    return {
      kind: "refused",
      reason: `"${value}" is not one of the thinking levels this agent offers`,
    };
  }
  return { kind: "overrides", overrides: { reasoning: value as never } };
}
