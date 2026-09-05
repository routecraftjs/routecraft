import {
  OPS_RESOURCES,
  parsePageQuery,
  rcCodeOf,
  rcError,
  registerOpsResource,
  type CraftContext,
  type CraftPlugin,
  type OpsPage,
} from "@routecraft/routecraft";
import { AgentSessionRuntime } from "./session/runtime.ts";
import type { AgentSessionSummary } from "./session/types.ts";
import { validateAgentOptions, validateBlocks } from "./agent.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
  ADAPTER_AGENT_SESSION_STORE,
  ADAPTER_AGENT_SESSIONS,
  ADAPTER_AGENT_SESSIONS_BOOT,
  ADAPTER_AGENT_TOOL_POLICIES,
  AGENT_DEFAULT_OPTION_KEYS,
} from "./store.ts";
import { createSessionStore } from "./session/config.ts";
import { AGENT_TOOL_POLICY_KINDS } from "./tools/policy.ts";
import type {
  AgentToolPolicy,
  AgentToolPolicyKind,
  AgentToolRule,
} from "./tools/policy.ts";
import { validateFnOptions } from "../fn/fn.ts";
import { ADAPTER_FN_REGISTRY } from "../fn/store.ts";
import { parseProviderModel } from "../llm/shared.ts";
import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";
import { isDeferredFn, resolveFnOptions, type FnEntry } from "./tools/types.ts";
import { isToolSelection } from "./tools/selection.ts";
import {
  describeToolNameViolation,
  TOOL_NAME_PATTERN_SOURCE,
} from "../tool-name.ts";

export interface AgentPluginOptions {
  /**
   * Agents available for by-name lookup via `agent("id")`. Keyed by the
   * agent id; each entry provides the agent's description, optional
   * model, system, and optional user-prompt override. Duplicate ids
   * across multiple `agentPlugin` installs throw at context init.
   */
  agents?: Record<string, AgentRegisteredOptions>;

  /**
   * Ad-hoc in-process functions available to agents (via `tools: [...]`
   * in follow-up stories). Keyed by the fn id; each entry is either an
   * eagerly-authored `FnOptions` (description, input, handler) or a
   * deferred descriptor emitted by a builder helper such as
   * `directTool(routeId)`.
   * Deferred descriptors resolve during this plugin's `start()`, once
   * every registry they depend on is live, and the result is memoised
   * for dispatch. A descriptor that cannot resolve there fails
   * `context.start()`: a tool naming a route that does not exist, or one
   * carrying no `.description()` or `.input()`, is a configuration error,
   * and it surfaces at the startup that introduced it rather than
   * mid-conversation when an agent first reaches for it.
   *
   * Duplicate ids across multiple `agentPlugin` installs throw at
   * context init.
   *
   * For tests, exercise registered fn handlers via `testFn` from
   * `@routecraft/testing` rather than dispatching through the plugin.
   */
  functions?: Record<string, FnEntry>;

  /**
   * Context-level defaults applied to any agent that doesn't override
   * them. Mirrors the `llmPlugin({ defaultOptions })` pattern:
   *
   * - `model` (`LlmModelId` string) is used by agents that omit `model`.
   *   Requires `llmPlugin` to be installed with the relevant provider.
   * - `tools` (`ToolSelection` from `tools([...])`) is used by agents
   *   that omit `tools`. Override-not-extend: an explicit `tools:` on
   *   an agent replaces this default entirely.
   *
   * Multiple `agentPlugin` installs that each set the same default
   * field throw at context init.
   */
  defaultOptions?: AgentDefaultOptions;

  /**
   * Repository-wide admission rules for the agent tool surface.
   *
   * Deliberately NOT part of `defaultOptions`: defaults are per-agent
   * overridable and a policy must not be. An agent's own `tools([...])`
   * selection cannot widen what this admits.
   *
   * Omit it and nothing changes: every tool is admitted, exactly as
   * before. Supply it and it becomes an allowlist in which every kind
   * must be decided: a partial policy is rejected at construction, not
   * quietly treated as denying the kinds you left out. Denied tools are
   * dropped from the agent's list and logged; they never throw.
   *
   * This is admission control, not a security boundary. It converts a
   * failure of omission (a tool name appearing in markdown frontmatter,
   * with no diff signal and nothing to notice) into a failure of
   * commission (someone must author a capability, name it, and write an
   * authorization line a reviewer can read). It does not stop a
   * developer who deliberately wraps a client tool in a capability.
   *
   * @see {@link AgentToolPolicy} for semantics and examples.
   */
  toolPolicy?: AgentToolPolicy;
}

function validateRegisteredAgent(
  id: string,
  options: AgentRegisteredOptions,
): void {
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
  // A registered agent is reached through `agent("id")`, whose overloads
  // declare `AgentResult`: there is no literal in the options object for the
  // widening overload to see. Accepting `stream` here would type every
  // by-name call as the consolidated result while the dispatch handed back
  // an iterable. It is also the wrong home for the option, because whether a
  // route's output is a stream belongs to that route, not to a definition
  // shared across every caller.
  if (options.stream !== undefined) {
    throw rcError("RC5003", undefined, {
      message:
        `agentPlugin: agent "${id}" sets "stream", which is a call-site decision rather than a registered one. ` +
        `Use agent({ ...options, stream: true }) inline on the route that streams.`,
    });
  }
  validateAgentOptions(options);
}

/**
 * Agent plugin: registers agents and functions in the context store so
 * routes can reference agents by name via `agent("id")` and so fns are
 * available to tool-using agents (the agent tool loop dispatches them
 * directly; there is no public dispatch API). Throws on duplicate id
 * (within agents, within fns, or across multiple plugin installs) at
 * context init.
 *
 * @example
 * ```typescript
 * import { agentPlugin } from "@routecraft/ai";
 * import { z } from "zod";
 *
 * agentPlugin({
 *   agents: {
 *     summariser: {
 *       description: "Summarises documents into bullet points",
 *       model: "anthropic:claude-opus-4-7",
 *       system: "You are a summariser. Be concise.",
 *     },
 *   },
 *   functions: {
 *     CurrentTime: {
 *       description: "Current UTC timestamp in ISO 8601",
 *       input: z.object({}),
 *       handler: async () => new Date().toISOString(),
 *     },
 *   },
 * });
 * ```
 */
export function agentPlugin(options: AgentPluginOptions = {}): CraftPlugin {
  const agents = options.agents ?? {};
  const functions = options.functions ?? {};
  const defaultOptions = validatePluginDefaults(options.defaultOptions);
  const toolPolicy = validateToolPolicy(options.toolPolicy);
  return {
    async apply(ctx: CraftContext) {
      // Merge into an existing registry when present so multiple
      // `agentPlugin({...})` entries compose instead of overwriting.
      const existingAgents = ctx.getStore(ADAPTER_AGENT_REGISTRY);
      const agentMap =
        existingAgents ?? new Map<string, AgentRegisteredOptions>();
      for (const [id, entry] of Object.entries(agents)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent id must be a non-empty string.`,
          });
        }
        if (entry === null || typeof entry !== "object") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent "${id}" entry must be an object with description, model, and system.`,
          });
        }
        if (entry.tools !== undefined && !isToolSelection(entry.tools)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: agent "${id}" "tools" must be the result of tools([...]).`,
          });
        }
        validateRegisteredAgent(id, entry);
        if (agentMap.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate agent id "${id}". Each agent id must be unique within a context.`,
          });
        }
        agentMap.set(id, entry);
      }
      if (!existingAgents) {
        ctx.setStore(ADAPTER_AGENT_REGISTRY, agentMap);
      }

      const existingFns = ctx.getStore(ADAPTER_FN_REGISTRY);
      const fnMap = existingFns ?? new Map<string, FnEntry>();
      for (const [id, entry] of Object.entries(functions)) {
        if (id.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: fn id must be a non-empty string.`,
          });
        }
        // A fn id IS the tool name the model sees, with no prefix and no
        // encoding in between, so the provider charset applies to it
        // directly. Checking at registration turns what was an opaque
        // provider-side rejection on the first dispatch into a startup
        // error naming the offending id.
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
        if (!isDeferredFn(entry)) {
          validateFnOptions(id, entry);
        }
        if (fnMap.has(id)) {
          throw rcError("RC5003", undefined, {
            message: `agentPlugin: duplicate fn id "${id}". Each fn id must be unique within a context.`,
          });
        }
        fnMap.set(id, entry);
      }
      if (!existingFns) {
        ctx.setStore(ADAPTER_FN_REGISTRY, fnMap);
      }

      if (defaultOptions !== undefined) {
        const existing = ctx.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS);
        const merged = mergePluginDefaults(existing, defaultOptions);
        ctx.setStore(ADAPTER_AGENT_DEFAULT_OPTIONS, merged);
      }

      if (toolPolicy !== undefined) {
        // Appended, never merged. Policies compose with AND at
        // evaluation time, so two installs that disagree narrow rather
        // than conflict, and neither needs to know about the other.
        const existingPolicies = ctx.getStore(ADAPTER_AGENT_TOOL_POLICIES);
        if (existingPolicies) {
          existingPolicies.push(toolPolicy);
        } else {
          ctx.setStore(ADAPTER_AGENT_TOOL_POLICIES, [toolPolicy]);
        }
      }

      // Once per context, whichever install applies first: the resource
      // reads the shared session runtime, so a second install has nothing
      // more to contribute and would collide on the name.
      if (ctx.getStore(OPS_RESOURCES)?.has(SESSIONS_RESOURCE) !== true) {
        registerSessionsResource(ctx);
      }

      // The default session store, unless a `sessions` block chose one (or
      // will: its plugin replaces an unconfigured default whichever applied
      // first). Resolved here so the driver is probed at boot.
      if (ctx.getStore(ADAPTER_AGENT_SESSION_STORE) === undefined) {
        ctx.setStore(
          ADAPTER_AGENT_SESSION_STORE,
          await createSessionStore(ctx, {}, false),
        );
      }
    },

    /**
     * Resolve every deferred tool, then announce what this install
     * registered.
     *
     * Both belong in `start()` rather than in an event handler. A direct
     * route registers its capability when its source subscribes, and core
     * emits `context:started` BEFORE routes start (see its own note on
     * `CraftContext.start`), so a deferred entry genuinely cannot resolve
     * at that moment. `start()` runs after `routes.ready`, which is the
     * first point where every registry a `directTool` depends on is live.
     *
     * It is also the only one of the two with failure semantics: a throw
     * here fails `context.start()` and unwinds cleanly, where a throw
     * inside a `once()` handler has no such contract.
     */
    start(ctx: CraftContext) {
      resolveDeferredTools(ctx, functions);
      emitRegistrations(ctx, agents, functions);
      driveSessionsAtBoot(ctx);
    },

    /**
     * A boot drive still walking the store at shutdown would revive
     * sessions onto routes that are draining and write the store after
     * the context let go of it; it is told to stop and waited for.
     */
    async teardown(ctx: CraftContext) {
      await boots.get(ctx);
      boots.delete(ctx);
      // After the boot walk, so a revival the walk was starting when the
      // stop landed is in the set the runtime waits for.
      await ctx.getStore(ADAPTER_AGENT_SESSIONS)?.stop();
      // Closed only once every revival has settled, and only if this
      // context opened it.
      await ctx.getStore(ADAPTER_AGENT_SESSION_STORE)?.close();
    },
  };
}

/** The boot drive per context, for teardown to wait on. */
const boots = new WeakMap<CraftContext, Promise<void>>();

/**
 * The `agent-sessions` management resource: every named session the
 * store knows, with its turn state and inbox depth, at
 * `GET /ops/agent-sessions` (filter with `?agent=`) and one session at
 * `GET /ops/agent-sessions/{agent}/{session}`. Served under the ops
 * plugin's introspection tier when an ops mount exists; inert otherwise.
 *
 * A context with no suspension store has no sessions, and says so with an
 * empty collection rather than the RC5052 a dispatch would get, because a
 * listing is a question and not an attempt to hold a conversation.
 *
 * @internal
 */
const SESSIONS_RESOURCE = "agent-sessions";

/**
 * What a previous process left in sessions is driven from here, after
 * the routes are live: background calls it was waiting on become lost
 * results and the stored continuations they were for are revived, so a
 * lost build reaches the model as a turn rather than waiting for a
 * message. Begun and returned rather than awaited, because it reads every
 * session the store holds; a context with no suspension store has nothing
 * to drive. Once per context, keyed on the first install like the
 * resource registration.
 */
function driveSessionsAtBoot(ctx: CraftContext): void {
  if (ctx.getStore(ADAPTER_AGENT_SESSIONS_BOOT) === true) return;
  ctx.setStore(ADAPTER_AGENT_SESSIONS_BOOT, true);
  let runtime: AgentSessionRuntime;
  try {
    runtime = AgentSessionRuntime.for(ctx);
  } catch (err) {
    if (rcCodeOf(err) === "RC5052") return;
    throw err;
  }
  const drive = runtime.driveBoot().then(
    ({ revived, lostBackground }) => {
      if (revived > 0 || lostBackground > 0) {
        ctx.logger.info(
          { revived, lostBackground },
          "Agent sessions left by the previous process were driven",
        );
      }
    },
    (err: unknown) => {
      ctx.logger.error(
        { err },
        "Agent sessions left by the previous process could not be driven; each is restored by its next message instead",
      );
    },
  );
  boots.set(ctx, drive);
}

function registerSessionsResource(ctx: CraftContext): void {
  const runtime = (): AgentSessionRuntime | undefined => {
    try {
      return AgentSessionRuntime.for(ctx);
    } catch (err) {
      if (rcCodeOf(err) === "RC5052") return undefined;
      throw err;
    }
  };
  registerOpsResource<AgentSessionSummary>(ctx, {
    name: SESSIONS_RESOURCE,
    async list(query): Promise<OpsPage<AgentSessionSummary>> {
      const sessions = runtime();
      if (!sessions) return { items: [] };
      const agent = query["agent"];
      return sessions.summaries({
        ...(agent !== undefined ? { agent } : {}),
        ...parsePageQuery(query),
      });
    },
    async describe(segments): Promise<AgentSessionSummary | undefined> {
      if (segments.length !== 2) return undefined;
      const [agent, session] = segments as [string, string];
      return runtime()?.summary({ agent, session });
    },
  });
}

/**
 * Resolve every deferred tool while the boot can still fail cleanly.
 *
 * A tool naming a route that does not exist, or one carrying no
 * `.description()` or `.input()`, is a configuration error. Left to
 * dispatch it surfaces as a tool failure mid-conversation, at whatever
 * hour the agent first reaches for it. Resolved here it fails the
 * startup that introduced it.
 *
 * The result is memoized per context, so dispatch reuses this resolution
 * rather than repeating it.
 *
 * @throws RC5003 when a deferred entry cannot resolve
 *
 * @internal
 */
function resolveDeferredTools(
  ctx: CraftContext,
  functions: Record<string, FnEntry>,
): void {
  for (const [id, entry] of Object.entries(functions)) {
    if (isDeferredFn(entry)) resolveFnOptions(ctx, id, entry);
  }
}

/**
 * Announce the agents and fns this plugin install registered, so that
 * generic observability (the telemetry plugin / TUI) can list them even
 * before any of them runs. Inline agents are not announced here: they
 * only exist at dispatch inside a route and surface via their
 * `route:agent:started` event instead.
 *
 * The events fire from `start()` rather than inside `apply()` so the
 * telemetry plugin has already subscribed regardless of plugin install
 * order (mirroring how `route:*:registered` fires after plugins are
 * applied). When the context is never started there is nothing running
 * to observe, so emitting nothing is correct.
 *
 * @internal
 */
function emitRegistrations(
  ctx: CraftContext,
  agents: Record<string, AgentRegisteredOptions>,
  functions: Record<string, FnEntry>,
): void {
  const agentEntries = Object.entries(agents);
  const fnEntries = Object.entries(functions);
  if (agentEntries.length === 0 && fnEntries.length === 0) return;

  for (const [id, entry] of agentEntries) {
    ctx.emit("agent:registered", {
      agentId: id,
      description: entry.description,
      ...(typeof entry.model === "string" && { model: entry.model }),
      source: "registered",
    });
  }
  for (const [id, entry] of fnEntries) {
    // Resolved, so a route-backed tool announces the same shape a
    // hand-written one does. Every deferred entry resolved during
    // start(), so this reads the memoized result and cannot fail here.
    const declared = resolveFnOptions(ctx, id, entry);
    ctx.emit("agent:tool:registered", {
      toolName: id,
      description: declared.description,
      ...(Array.isArray(declared.tags) &&
        declared.tags.length > 0 && { tags: declared.tags }),
      source: "registered",
    });
  }
}

/**
 * Validate the shape of `agentPlugin({ defaultOptions: ... })` at
 * plugin-construction time. Returns the validated value (with no
 * mutations) or undefined when no defaults were supplied.
 *
 * @internal
 */
function validatePluginDefaults(
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
    // Run the same validation as AgentOptions.blocks (blank names, the
    // reserved `_block_` namespace, provider-unsafe / over-long loader
    // names, flatten collisions, malformed BlockBody values) at plugin
    // construction rather than at agent dispatch. The `defaultsLabel`
    // argument additionally rejects `false` at every nesting level,
    // because defaults are the base layer and cannot remove themselves;
    // the error names the offending entry by its flattened path.
    validateBlocks(raw.blocks, "defaultOptions.blocks");
  }
  return raw;
}

/**
 * Validate the shape of `agentPlugin({ toolPolicy })` at plugin
 * construction. Every entry must be a boolean or a function; anything
 * else is a config mistake that would otherwise surface as a silent
 * denial on the first dispatch (a non-callable rule cannot admit
 * anything), which is exactly the failure mode a policy must not have.
 *
 * An empty object is accepted and is meaningful: it denies every kind,
 * because a present policy is an allowlist.
 *
 * @internal
 */
function validateToolPolicy(
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
    // An explicit `undefined` is rejected, not skipped. Owning the key
    // with an undefined value satisfies the missing-key check above
    // while `ruleAdmits` treats it as a denial at dispatch, which is
    // precisely the silent strip that requiring every key exists to
    // prevent. There is no reading of `mcp: undefined` where dropping
    // every MCP tool with only a warn line is what the author meant.
    if (typeof rule !== "boolean" && typeof rule !== "function") {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: "toolPolicy.${key}" must be a boolean or a (tool, ctx) => boolean predicate (got ${typeof rule}).`,
      });
    }
  }
  // Shallow-copied so a caller holding a reference cannot add or
  // remove kinds after the context installed the policy. Predicates
  // stay caller-owned by design; this only closes the key-level
  // mutation path, which would otherwise contradict the promise that
  // a policy is not overridable once set.
  return { ...raw };
}

/**
 * Merge a freshly-supplied `defaultOptions` into the value already
 * stored by a previous `agentPlugin` install. Per-field conflicts
 * throw so a context cannot accidentally end up with two competing
 * defaults for the same field.
 *
 * @internal
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
  // Blocks merge additively across multiple `agentPlugin` installs:
  // each install contributes named entries, and a name set in two
  // installs throws so we never silently pick one. This differs from
  // `model` / `tools` (single-valued) and matches how blocks compose
  // per-agent: independent named contributions.
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
