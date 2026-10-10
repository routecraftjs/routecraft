import { rcError } from "@routecraft/routecraft";
import { validateFnOptions } from "../fn/fn.ts";
import { parseProviderModel } from "../llm/shared.ts";
import {
  describeToolNameViolation,
  TOOL_NAME_PATTERN_SOURCE,
} from "../tool-name.ts";
import { validateAdvertisedChoices } from "./advertised.ts";
import { validateAgentOptions, validateBlocks } from "./agent.ts";
import type { AgentContribution, AgentRegistry } from "./port.ts";
import {
  noContinuationsStore,
  type AgentSessionRuntime,
} from "./session/runtime.ts";
import { AGENT_DEFAULT_OPTION_KEYS } from "./store.ts";
import { AGENT_TOOL_POLICY_KINDS } from "./tools/policy.ts";
import type {
  AgentToolPolicy,
  AgentToolPolicyKind,
  AgentToolRule,
} from "./tools/policy.ts";
import type { ReidentifyHook } from "./session/types.ts";
import { isToolSelection } from "./tools/selection.ts";
import { isLazyFn, type FnEntry, type RegisteredFn } from "./tools/types.ts";
import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";

/**
 * The agent runtime's registry. Contributions arrive from every
 * `agentPlugin()` install's bind and are refused once the application froze,
 * because whatever read them during bind has already used them.
 *
 * @internal
 */
export class AgentRegistryImpl implements AgentRegistry {
  readonly agents = new Map<string, AgentRegisteredOptions>();
  readonly functions = new Map<string, FnEntry>();
  readonly toolPolicies: AgentToolPolicy[] = [];
  /** Resolved deferred functions by id, filled when the runtime starts. */
  readonly resolvedFunctions = new Map<string, RegisteredFn>();
  #defaults: AgentDefaultOptions | undefined;
  #reidentify: ReidentifyHook | undefined;

  /**
   * @param frozen - Whether the application froze, read on every contribution
   * @param runtime - The session runtime the application bound, or
   *   `undefined` when it has no continuations store to hold one on
   */
  constructor(
    private readonly frozen: () => boolean,
    private readonly runtime: AgentSessionRuntime | undefined,
  ) {}

  get defaults(): AgentDefaultOptions | undefined {
    return this.#defaults;
  }

  get reidentify(): ReidentifyHook | undefined {
    return this.#reidentify;
  }

  contribute(contribution: AgentContribution): void {
    if (this.frozen()) {
      throw rcError("RC1110", undefined, {
        message: `An agent contribution (${describeContribution(contribution)}) arrived after the application froze. Contribute agents and functions from a plugin's bind(c), with AGENTS in its requires.`,
      });
    }
    // Validated as a whole before anything is written, so a refused
    // contribution leaves the registry as every earlier one left it.
    const agents = Object.entries(contribution.agents ?? {});
    for (const [id, entry] of agents) {
      validateRegisteredAgent(id, entry);
      if (this.agents.has(id)) {
        throw rcError("RC5003", undefined, {
          message: `agentPlugin: duplicate agent id "${id}". Each agent id must be unique within a context.`,
        });
      }
    }
    const functions = Object.entries(contribution.functions ?? {});
    for (const [id, entry] of functions) {
      validateRegisteredFn(id, entry);
      if (this.functions.has(id)) {
        throw rcError("RC5003", undefined, {
          message: `agentPlugin: duplicate fn id "${id}". Each fn id must be unique within a context.`,
        });
      }
    }
    const defaults = validatePluginDefaults(contribution.defaultOptions);
    const merged =
      defaults === undefined
        ? this.#defaults
        : mergePluginDefaults(this.#defaults, defaults);
    const toolPolicy = validateToolPolicy(contribution.toolPolicy);
    const reidentify = validateReidentify(contribution.reidentify);
    if (reidentify !== undefined && this.#reidentify !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "reidentify" is already set on this context. One hook re-verifies a parked identity for the whole application; register it on one install.`,
      });
    }

    for (const [id, entry] of agents) this.agents.set(id, entry);
    for (const [id, entry] of functions) this.functions.set(id, entry);
    this.#defaults = merged;
    if (reidentify !== undefined) this.#reidentify = reidentify;
    // Appended, never merged. Policies compose with AND at evaluation
    // time, so two contributions that disagree narrow rather than
    // conflict, and neither needs to know about the other.
    if (toolPolicy !== undefined) this.toolPolicies.push(toolPolicy);
  }

  sessions(): AgentSessionRuntime {
    if (this.runtime === undefined) throw noContinuationsStore();
    return this.runtime;
  }

  resolvedFunction(id: string): RegisteredFn | undefined {
    return this.resolvedFunctions.get(id);
  }
}

/** What a late contribution carried, for the refusal to name. */
function describeContribution(contribution: AgentContribution): string {
  const parts = [
    ...Object.keys(contribution.agents ?? {}).map((id) => `agent "${id}"`),
    ...Object.keys(contribution.functions ?? {}).map((id) => `fn "${id}"`),
    ...(contribution.defaultOptions !== undefined ? ["defaultOptions"] : []),
    ...(contribution.toolPolicy !== undefined ? ["toolPolicy"] : []),
    ...(contribution.reidentify !== undefined ? ["reidentify"] : []),
  ];
  return parts.length === 0 ? "empty" : parts.join(", ");
}

/** @internal */
export function validateReidentify(
  raw: ReidentifyHook | undefined,
): ReidentifyHook | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "function") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "reidentify" must be a function (parked: Principal, { signal }) => Principal | undefined, or a promise of one.`,
    });
  }
  return raw;
}

function validateRegisteredAgent(
  id: string,
  options: AgentRegisteredOptions,
): void {
  if (id.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: agent id must be a non-empty string.`,
    });
  }
  if (options === null || typeof options !== "object") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: agent "${id}" entry must be an object with description, model, and system.`,
    });
  }
  if (options.tools !== undefined && !isToolSelection(options.tools)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: agent "${id}" "tools" must be the result of tools([...]).`,
    });
  }
  if (
    typeof options.description !== "string" ||
    options.description.trim() === ""
  ) {
    throw rcError("RC5003", undefined, {
      message:
        `agentPlugin: agent "${id}" is missing a non-empty "description". ` +
        `Registered agents carry their own description because they are not ` +
        `backed by a route.`,
    });
  }
  // `agent("id")` is typed as the consolidated result; a stream belongs to the route.
  if (options.stream !== undefined) {
    throw rcError("RC5003", undefined, {
      message:
        `agentPlugin: agent "${id}" sets "stream", which is a call-site decision rather than a registered one. ` +
        `Use agent({ ...options, stream: true }) inline on the route that streams.`,
    });
  }
  validateAgentOptions(options);
  validateAdvertisedChoices(`agentPlugin: agent "${id}"`, options);
}

function validateRegisteredFn(id: string, entry: FnEntry): void {
  if (id.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn id must be a non-empty string.`,
    });
  }
  // A fn id IS the tool name the model sees, with no prefix and no
  // encoding in between, so the provider charset applies to it directly.
  // Checking at registration turns what was an opaque provider-side
  // rejection on the first dispatch into a startup error naming the id.
  const idViolation = describeToolNameViolation(id);
  if (idViolation !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn id "${id}" is not usable as a tool name: ${idViolation}.`,
      suggestion: `A fn id reaches the model provider verbatim as the tool name, so it must match ${TOOL_NAME_PATTERN_SOURCE}. Rename the fn.`,
    });
  }
  if (entry === null || typeof entry !== "object") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" entry must be an object with description, input, and handler.`,
    });
  }
  if (!isLazyFn(entry)) validateFnOptions(id, entry);
}

/**
 * Validate the shape of `agentPlugin({ defaultOptions: ... })`. Returns the
 * value unchanged, or undefined when no defaults were supplied.
 *
 * @internal
 */
export function validatePluginDefaults(
  raw: AgentDefaultOptions | undefined,
): AgentDefaultOptions | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions" must be an object with optional "model" / "tools".`,
    });
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "defaultOptions.model" must be a non-empty "providerId:modelName" string.`,
      });
    }
    try {
      parseProviderModel(raw.model);
    } catch {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "defaultOptions.model" must be in "providerId:modelName" form (e.g. anthropic:claude-opus-4-7). Got: "${raw.model}"`,
      });
    }
  }
  if (raw.tools !== undefined && !isToolSelection(raw.tools)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.tools" must be the result of tools([...]).`,
    });
  }
  if (raw.blocks !== undefined) {
    // The same validation as AgentOptions.blocks, at construction rather
    // than at dispatch. The `defaultsLabel` argument additionally rejects
    // `false` at every nesting level, because defaults are the base layer
    // and cannot remove themselves.
    validateBlocks(raw.blocks, "defaultOptions.blocks");
  }
  return raw;
}

/**
 * Validate the shape of `agentPlugin({ toolPolicy })`. Every entry must be a
 * boolean or a function; anything else would surface as a silent denial on
 * the first dispatch (a non-callable rule cannot admit anything), which is
 * exactly the failure mode a policy must not have.
 *
 * An empty object is accepted and is meaningful: it denies every kind,
 * because a present policy is an allowlist.
 *
 * @internal
 */
export function validateToolPolicy(
  raw: AgentToolPolicy | undefined,
): AgentToolPolicy | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "toolPolicy" must be an object carrying a rule for each of "fn" / "direct" / "mcp".`,
    });
  }
  const known = AGENT_TOOL_POLICY_KINDS;
  const missing = known.filter(
    (k) => !Object.prototype.hasOwnProperty.call(raw, k),
  );
  if (missing.length > 0) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "toolPolicy" is missing a rule for ${missing.map((k) => `"${k}"`).join(", ")}.`,
      suggestion:
        `A policy is an allowlist, so an unlisted kind is denied. Decide each kind explicitly ` +
        `(\`true\`, \`false\`, or a predicate) rather than omitting it, so a partial policy cannot ` +
        `silently strip tools you meant to keep.`,
    });
  }
  for (const key of Object.keys(raw)) {
    if (!known.includes(key as AgentToolPolicyKind)) {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "toolPolicy.${key}" is not a known tool kind. Valid keys: ${known.join(", ")}.`,
        suggestion: `Block loader tools are framework machinery and are deliberately not policy-governed, so there is no "block" key.`,
      });
    }
    const rule = raw[key as AgentToolPolicyKind] as AgentToolRule | undefined;
    // An explicit `undefined` would pass the key check and deny at dispatch.
    if (typeof rule !== "boolean" && typeof rule !== "function") {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "toolPolicy.${key}" must be a boolean or a (tool, ctx) => boolean predicate (got ${typeof rule}).`,
      });
    }
  }
  // Shallow-copied so a caller holding a reference cannot add or remove
  // kinds after the application installed the policy. Predicates stay
  // caller-owned by design; this only closes the key-level mutation path.
  return { ...raw };
}

/**
 * Merge a contribution's `defaultOptions` into what earlier contributions
 * set. Per-field conflicts throw so an application cannot end up with two
 * competing defaults for the same field.
 */
function mergePluginDefaults(
  existing: AgentDefaultOptions | undefined,
  next: AgentDefaultOptions,
): AgentDefaultOptions {
  if (!existing) return { ...next };
  if (next.model !== undefined && existing.model !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.model" is already set on this context. A context can have only one default model.`,
    });
  }
  if (next.tools !== undefined && existing.tools !== undefined) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: "defaultOptions.tools" is already set on this context. Combine selectors into a single tools([...]) call.`,
    });
  }
  // Blocks merge by name, and a name set twice throws.
  let mergedBlocks: typeof existing.blocks | undefined;
  if (existing.blocks !== undefined || next.blocks !== undefined) {
    mergedBlocks = { ...(existing.blocks ?? {}) };
    if (next.blocks !== undefined) {
      for (const [name, body] of Object.entries(next.blocks)) {
        if (Object.prototype.hasOwnProperty.call(mergedBlocks, name)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: "defaultOptions.blocks" already contains "${name}" from a previous install. Each block name may be defined once across all installs.`,
          });
        }
        mergedBlocks[name] = body;
      }
    }
  }
  const merged: AgentDefaultOptions = { ...existing };
  for (const key of AGENT_DEFAULT_OPTION_KEYS) {
    const value = next[key];
    if (value === undefined) continue;
    // `model` and `tools` already threw above with their own wording.
    if (existing[key] !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "defaultOptions.${key}" is already set on this context. A context can have only one default for it.`,
      });
    }
    Object.assign(merged, { [key]: value });
  }
  if (mergedBlocks !== undefined) merged.blocks = mergedBlocks;
  return merged;
}
