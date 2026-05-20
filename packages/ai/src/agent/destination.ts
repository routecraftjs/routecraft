import {
  getExchangeContext,
  getExchangeRoute,
  rcError,
  type CraftContext,
  type Destination,
  type Exchange,
  type Principal,
} from "@routecraft/routecraft";
import { resolveModel, resolvePrompt } from "../llm/shared.ts";
import {
  AgentSession,
  buildUserPrompt,
  dispatchIdentityFrom,
} from "./session.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
} from "./store.ts";
import { ADAPTER_SKILL_REGISTRY, type Skill } from "../skill/types.ts";
import type { AgentDeltaListener } from "./events.ts";
import type { ResolvedTool } from "./tools/selection.ts";
import type {
  AgentDefaultOptions,
  AgentOptions,
  AgentPrincipalRenderer,
  AgentRegisteredOptions,
  AgentResult,
} from "./types.ts";

const AGENT_REGISTRY_STORE_DESCRIPTION =
  ADAPTER_AGENT_REGISTRY.description ?? "routecraft.adapter.agent.registry";

/**
 * Per-call overrides accepted by the by-name `agent("name", { ... })`
 * factory. Constrained to fields that are inherently request-scoped
 * (the SSE / WebSocket / TUI consumer for `onDelta` is not known at
 * registration time). Anything else (model, system, tools, output)
 * stays authoritative on the registered options.
 *
 * @experimental
 */
export interface AgentByNameOverrides {
  /**
   * Per-request token-delta listener. Mirrors `AgentOptions.onDelta`
   * but lives at the call site so each dispatch can stream into its
   * own consumer without cross-talk.
   */
  onDelta?: AgentDeltaListener;
}

/** Discriminated state: inline options or a registry name. */
export type AgentBinding =
  | { kind: "inline"; options: AgentOptions }
  | {
      kind: "by-name";
      name: string;
      perCall?: AgentByNameOverrides;
    };

/**
 * Agent destination adapter. Resolves agent options (inline or
 * registered), merges them with `agentPlugin({ defaultOptions })`,
 * resolves the agent's tool selection against the live context, and
 * dispatches the tool-calling loop via {@link AgentSession}. Replaces
 * the exchange body with `AgentResult { text, output?, reasoning?, usage? }`.
 *
 * Resolution: when constructed inline, uses options directly. When
 * constructed by name, resolves the registered agent from the context
 * store (`ADAPTER_AGENT_REGISTRY`) at dispatch time, throwing a clear
 * error if the name is unknown.
 *
 * @experimental
 */
export class AgentDestinationAdapter implements Destination<
  unknown,
  AgentResult
> {
  readonly adapterId = "routecraft.adapter.agent";

  constructor(public readonly binding: AgentBinding) {}

  async send(exchange: Exchange<unknown>): Promise<AgentResult> {
    const context = getExchangeContext(exchange);
    const baseOptions = this.resolveOptions(context);
    const merged = mergeWithDefaults(baseOptions, context);

    if (merged.model === undefined) {
      throw rcError("RC5003", undefined, {
        message:
          `Agent: no "model" supplied and no agentPlugin({ defaultOptions: { model } }) is set on this context. ` +
          `Specify "model" on the agent or set a context-level default.`,
      });
    }

    const { config, modelName } = resolveModel(merged.model, context);
    const tools = resolveAgentTools(merged, context);
    const user = buildUserPrompt(merged, exchange);
    // System accepts the same string-or-function shape as `llm({ system })`,
    // so resolve it against the exchange here. The session then receives a
    // plain string, matching what the provider layer expects.
    const baseSystem = resolvePrompt(merged.system, exchange);
    // Mirror the construction-time check (validateAgentOptions) so a
    // function-form `system` resolver can't silently drop the prompt at
    // dispatch by returning an empty string.
    if (baseSystem.trim() === "") {
      throw rcError("RC5003", undefined, {
        message:
          `Agent: "system" resolved to an empty string. ` +
          `When "system" is a function, it must return a non-empty string for the incoming exchange.`,
      });
    }
    const withSkills = appendSkillsToSystem(baseSystem, merged.skills, context);
    // Caller identity is appended last (after skills) so the author's own
    // prompt and any skill content frame the model first, with the
    // request-scoped "who am I serving" footer closest to the user turn.
    const system = appendPrincipalToSystem(
      withSkills,
      merged.principal,
      exchange.principal,
      exchange,
    );

    const route = getExchangeRoute(exchange);
    const dispatchIdentity = dispatchIdentityFrom(
      exchange,
      route?.definition.id,
    );

    const session = new AgentSession({
      options: merged,
      modelConfig: config,
      modelName,
      tools,
      user,
      system,
      context,
      exchange,
      dispatchIdentity,
    });

    // Thread the route's abort signal through so the agent dispatch
    // (LLM call + in-flight tool handlers) is cancelled when the
    // route or context shuts down. Falls back to a never-firing
    // signal when the exchange has no route binding (rare; mostly
    // synthetic exchanges in tests).
    const abortSignal = route?.signal ?? new AbortController().signal;

    // Streaming is selected by the presence of `onDelta` on the
    // merged options or as a per-call override at the by-name call
    // site. Per-call wins because it's request-scoped (e.g. a
    // specific SSE channel for THIS dispatch).
    const onDelta =
      this.binding.kind === "by-name"
        ? (this.binding.perCall?.onDelta ?? merged.onDelta)
        : merged.onDelta;
    // The consolidated AgentResult is returned in both paths, so
    // downstream pipeline ops are unaffected by the choice.
    if (onDelta !== undefined) {
      return await session.runStream(abortSignal, onDelta);
    }
    return await session.runUntilDone(abortSignal);
  }

  /** Pull the agent options for this dispatch, either inline or from the registry. */
  private resolveOptions(
    context: CraftContext | undefined,
  ): AgentOptions | AgentRegisteredOptions {
    if (this.binding.kind === "inline") return this.binding.options;

    if (!context) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" requires a context to resolve. ` +
          `Ensure the exchange has context (e.g. from a route) so the ` +
          `"${AGENT_REGISTRY_STORE_DESCRIPTION}" store can be read.`,
      });
    }
    const registry = context.getStore(
      ADAPTER_AGENT_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, AgentRegisteredOptions> | undefined;
    if (!registry) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" not found: no agents registered. ` +
          `Add agentPlugin({ agents: { "${this.binding.name}": {...} } }) to your config.`,
      });
    }
    const found = registry.get(this.binding.name);
    if (!found) {
      const known = Array.from(registry.keys()).join(", ") || "<none>";
      throw rcError("RC5004", undefined, {
        message: `Agent "${this.binding.name}" not found in registry. Known agents: ${known}.`,
      });
    }
    return found;
  }

  /**
   * Extract metadata from the agent result for observability. Includes the
   * resolved model (as string) and token usage when reported.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const r = result as AgentResult;
    const metadata: Record<string, unknown> = {};
    if (this.binding.kind === "by-name") metadata["agent"] = this.binding.name;
    if (this.binding.kind === "inline") {
      const model = this.binding.options.model;
      if (typeof model === "string") metadata["model"] = model;
    }
    if (r.usage?.inputTokens !== undefined) {
      metadata["inputTokens"] = r.usage.inputTokens;
    }
    if (r.usage?.outputTokens !== undefined) {
      metadata["outputTokens"] = r.usage.outputTokens;
    }
    return metadata;
  }
}

/**
 * Merge per-agent options with the context-level defaults registered
 * via `agentPlugin({ defaultOptions: {...} })`. Per-agent values win
 * per key; missing fields fall back to defaults (mirrors the LLM
 * destination's `mergedOptions` pattern).
 *
 * @internal
 */
function mergeWithDefaults(
  base: AgentOptions | AgentRegisteredOptions,
  context: CraftContext | undefined,
): AgentOptions | AgentRegisteredOptions {
  const defaults = context?.getStore(
    ADAPTER_AGENT_DEFAULT_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as AgentDefaultOptions | undefined;
  if (!defaults) return base;
  const out = { ...base } as AgentOptions | AgentRegisteredOptions;
  if (out.model === undefined && defaults.model !== undefined) {
    out.model = defaults.model;
  }
  if (out.tools === undefined && defaults.tools !== undefined) {
    out.tools = defaults.tools;
  }
  if (out.maxTurns === undefined && defaults.maxTurns !== undefined) {
    out.maxTurns = defaults.maxTurns;
  }
  if (out.principal === undefined && defaults.principal !== undefined) {
    out.principal = defaults.principal;
  }
  return out;
}

/**
 * Resolve the agent's `tools` selection against the live context. The
 * selection is the `ToolSelection` object built via `tools([...])`;
 * resolution walks the fn registry and direct registry to produce the
 * final `ResolvedTool[]` the runtime hands to the LLM.
 *
 * Returns an empty array when the agent has no tools field set
 * (and no context-default tools were inherited).
 *
 * @internal
 */
function resolveAgentTools(
  options: AgentOptions | AgentRegisteredOptions,
  context: CraftContext | undefined,
): ResolvedTool[] {
  if (options.tools === undefined) return [];
  if (!context) {
    throw rcError("RC5003", undefined, {
      message: `Agent: cannot resolve tools without a CraftContext.`,
    });
  }
  return options.tools.resolve(context);
}

/**
 * Build the final system prompt by concatenating the resolved skill
 * content (when the agent declared `skills: ["name", ...]`) onto the
 * agent's own system prompt. Each skill is wrapped in a heading so the
 * model can see the skill name and its boundary in context.
 *
 * Throws `RC5003` when a referenced skill name is not registered,
 * when an agent declares `skills` but no skills are registered at all,
 * or when the agent has no live context to look up skills against.
 *
 * @internal
 */
function appendSkillsToSystem(
  baseSystem: string,
  skills: string[] | undefined,
  context: CraftContext | undefined,
): string {
  if (!skills || skills.length === 0) return baseSystem;
  if (!context) {
    throw rcError("RC5003", undefined, {
      message: `Agent: cannot resolve "skills" without a CraftContext.`,
    });
  }
  const registry = context.getStore(
    ADAPTER_SKILL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, Skill> | undefined;
  if (!registry || registry.size === 0) {
    throw rcError("RC5003", undefined, {
      message: `Agent: declared "skills" (${skills.map((s) => `"${s}"`).join(", ")}) but no skills are registered in this context. Install agentPlugin({ skills }) with the relevant entries.`,
    });
  }
  const parts: string[] = [baseSystem];
  for (const name of skills) {
    const skill = registry.get(name);
    if (!skill) {
      const known = [...registry.keys()].sort();
      throw rcError("RC5003", undefined, {
        message:
          `Agent: unknown skill "${name}". ` +
          (known.length > 0
            ? `Known skill names: ${known.map((k) => `"${k}"`).join(", ")}.`
            : `No skills are registered in this context.`),
      });
    }
    parts.push(`\n\n## Skill: ${skill.name}\n\n${skill.content}`);
  }
  return parts.join("");
}

/**
 * Append a `## Caller` section describing the request's principal. Opt-in:
 * returns the base prompt unchanged when `principal` is omitted or `false`,
 * so existing agents are unaffected. When `principal` is a function it
 * renders the section itself (an empty return appends nothing); otherwise
 * the built-in {@link formatCallerSection} block is used.
 *
 * The section is informational context for the model (who triggered the
 * request), never an authorization gate; `.authorize()` and guards remain
 * the only enforcement points.
 *
 * @internal
 */
function appendPrincipalToSystem(
  baseSystem: string,
  principalOption: boolean | AgentPrincipalRenderer | undefined,
  principal: Principal | undefined,
  exchange: Exchange<unknown>,
): string {
  if (principalOption === undefined || principalOption === false) {
    return baseSystem;
  }
  const section =
    typeof principalOption === "function"
      ? principalOption(principal, exchange)
      : formatCallerSection(principal);
  if (section.trim() === "") return baseSystem;
  return `${baseSystem}\n\n${section}`;
}

/**
 * Render the built-in `## Caller` block from a principal. Surfaces only
 * the loggable identity fields (`name`, `email`, `subject`) and `roles`
 * (see `.standards/security.md` § 3); scopes, `claims`, `userinfoClaims`,
 * and the bearer token are never included. Absent fields are omitted
 * rather than printed as `undefined`. When no principal is present the
 * block states the request is unauthenticated so the model does not
 * invent an identity.
 *
 * @internal
 */
function formatCallerSection(principal: Principal | undefined): string {
  if (!principal) {
    return (
      "## Caller\n\n" +
      "The current request is not authenticated. No verified user identity " +
      "is available. Do not assume, infer, or invent the caller's name, " +
      "email, or permissions."
    );
  }
  const lines: string[] = [];
  if (principal.name) lines.push(`- Name: ${oneLine(principal.name)}`);
  if (principal.email) lines.push(`- Email: ${oneLine(principal.email)}`);
  lines.push(`- Subject: ${oneLine(principal.subject)}`);
  const roles = principal.roles
    ?.map((r) => oneLine(r))
    .filter((r) => r.length > 0);
  if (roles && roles.length > 0) {
    lines.push(`- Roles: ${roles.join(", ")}`);
  }
  return `## Caller\n\nThe current request is authenticated.\n${lines.join("\n")}`;
}

/**
 * Collapse newlines (and surrounding whitespace) in an interpolated
 * identity field. Principal strings like `name` / `email` are
 * integrity-verified (they reached us unmodified from the IdP) but may be
 * subject-controlled at self-service IdPs; collapsing newlines pins a
 * value to its `- Label:` line so it cannot break out of the list item or
 * forge a `##` heading in the trusted system channel.
 *
 * @internal
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}
