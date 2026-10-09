import {
  CONTINUATIONS,
  OPS,
  REMOTES,
  parsePageQuery,
  type Plugin,
  type PluginContext,
  type OpsPage,
  type OpsService,
} from "@routecraft/routecraft";
import { AgentSessionRuntime } from "./session/runtime.ts";
import type {
  AgentSessionScope,
  AgentSessionSummary,
} from "./session/types.ts";
import { defaultSessionsPlugin } from "./session/config.ts";
import { SESSION_STORE } from "./session/port.ts";
import { AGENTS, type AgentContribution } from "./port.ts";
import {
  AgentRegistryImpl,
  validatePluginDefaults,
  validateToolPolicy,
} from "./registry.ts";
import type { AgentToolPolicy } from "./tools/policy.ts";
import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";
import {
  isLazyFn,
  resolveFnOptions,
  type FnEntry,
  type ToolHost,
} from "./tools/types.ts";

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

/**
 * Agent plugin: contributes agents and functions to the application, so
 * routes can reference agents by name via `agent("id")` and so fns are
 * available to tool-using agents (the agent tool loop dispatches them
 * directly; there is no public dispatch API).
 *
 * Install it as often as the application needs: every install is one
 * contribution to the agent runtime, which each install brings along and
 * the application gets once. Contributions compose. A duplicate agent or
 * fn id, or a default set by two installs, fails the build; tool policies
 * from several installs all apply.
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
export function agentPlugin(options: AgentPluginOptions = {}): Plugin {
  const defaultOptions = validatePluginDefaults(options.defaultOptions);
  const toolPolicy = validateToolPolicy(options.toolPolicy);
  const contribution: AgentContribution = {
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
    ...(options.functions !== undefined
      ? { functions: options.functions }
      : {}),
    ...(defaultOptions !== undefined ? { defaultOptions } : {}),
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
  };
  return {
    id: "routecraft.ai.agent.contribution",
    namespace: "agent-contribution",
    repeatable: true,
    requires: [AGENTS],
    installs: [agentRuntimePlugin()],
    bind(c: PluginContext) {
      c.require(AGENTS).contribute(contribution);
    },
  };
}

/** What the runtime holds for one application. */
interface AgentRun {
  readonly registry: AgentRegistryImpl;
  readonly tools: ToolHost;
  /** The session runtime, or `undefined` without a continuations store. */
  readonly sessions: AgentSessionRuntime | undefined;
  boot?: Promise<void> | undefined;
}

/**
 * The agent runtime: provides the {@link AGENTS} registry every
 * `agentPlugin()` contributes to, owns the session runtime the agents hold
 * their conversations in, and brings along the default sessions plugin a
 * `sessions` block replaces. Brought along by every `agentPlugin()`, so an
 * application never lists it.
 *
 * @internal
 */
export function agentRuntimePlugin(): Plugin {
  return (agentRuntime ??= createAgentRuntimePlugin());
}

// One descriptor per process: every bundle that brings the runtime brings
// this one, so two bundles in one application never compete for its id.
let agentRuntime: Plugin | undefined;

function createAgentRuntimePlugin(): Plugin {
  // Keyed by the plugin context: one descriptor serves two applications in
  // one process (a config reused across tests).
  const runs = new WeakMap<PluginContext, AgentRun>();
  return {
    id: "routecraft.ai.agent",
    provides: [AGENTS],
    requires: [SESSION_STORE],
    // REMOTES orders the remotes plugin first, so its imported routes are
    // capabilities by the time start() resolves directTool references.
    optional: [CONTINUATIONS, OPS, REMOTES],
    installs: [defaultSessionsPlugin()],
    bind(c: PluginContext) {
      // Opened here rather than on first use, so it is retained on the store
      // and stopped with it on every path, including a first use after stop.
      const runtime: AgentSessionRuntime | undefined =
        c.lookup(CONTINUATIONS) === undefined
          ? undefined
          : AgentSessionRuntime.create(
              {
                logger: c.logger,
                emit: (event, details) => c.emit(event, details),
                continuations: () => c.lookup(CONTINUATIONS),
                resume: (request) => c.execution.resume(request),
                agent: (name) => registry.agents.get(name),
              },
              c.require(SESSION_STORE),
            );
      if (runtime !== undefined) {
        // Latched as shutdown begins, before the routes drain, so a
        // completion or a post landing during the drain starts no turn on
        // it; closing the store awaits the same stop() for the revivals.
        c.observe("context:stopping", () => {
          void runtime.stop();
        });
      }
      const registry: AgentRegistryImpl = new AgentRegistryImpl(
        () => c.frozen,
        runtime,
      );
      const tools: ToolHost = {
        logger: c.logger,
        capabilities: () => c.execution.capabilities(),
        hasRoute: (routeId) => c.routes.get(routeId) !== undefined,
        deliver: (endpoint, body, headers) =>
          c.execution.deliver(endpoint, body, headers),
        sessions: () => registry.sessions(),
      };
      runs.set(c, { registry, tools, sessions: runtime });
      c.provide(AGENTS, registry);
      const ops = c.lookup(OPS);
      if (ops !== undefined) registerSessionsResource(runtime, ops);
    },

    /**
     * Resolve every deferred tool, announce what was registered, and drive
     * what the previous process left in sessions.
     *
     * Resolution belongs in `start()` rather than in an event handler. A
     * direct route registers its capability when its source subscribes,
     * and core emits `context:started` BEFORE routes start, so a deferred
     * entry genuinely cannot resolve at that moment. `start()` runs after
     * `routes.ready`, the first point where every registry a `directTool`
     * depends on is live, and a throw here fails `context.start()` and
     * unwinds cleanly, where a throw inside an event handler has no such
     * contract.
     */
    start(c: PluginContext) {
      const run = runs.get(c);
      if (!run) return;
      resolveLazyTools(run);
      emitRegistrations(c, run);
      run.boot =
        run.sessions === undefined
          ? undefined
          : driveSessionsAtBoot(c, run.sessions);
    },

    /**
     * A boot drive still walking the store at shutdown would revive
     * sessions onto routes that are draining and write the store after the
     * application let go of it, so it is waited for. The session runtime
     * itself stops when the sessions plugin closes the store it is retained
     * on, which happens after this, in reverse install order.
     */
    async stop(c: PluginContext) {
      const run = runs.get(c);
      runs.delete(c);
      await run?.boot;
    },
  };
}

/**
 * What a previous process left in sessions is driven from here, after the
 * routes are live: background calls it was waiting on become lost results
 * and the stored continuations they were for are revived, so a lost build
 * reaches the model as a turn rather than waiting for a message. Begun and
 * returned rather than awaited, because it reads every session the store
 * holds; an application with no continuations store has nothing to drive.
 */
function driveSessionsAtBoot(
  c: PluginContext,
  runtime: AgentSessionRuntime,
): Promise<void> {
  return runtime.driveBoot().then(
    ({ revived, lostBackground }) => {
      if (revived > 0 || lostBackground > 0) {
        c.logger.info(
          { revived, lostBackground },
          "Agent sessions left by the previous process were driven",
        );
      }
    },
    (err: unknown) => {
      c.logger.error(
        { err },
        "Agent sessions left by the previous process could not be driven; each is restored by its next message instead",
      );
    },
  );
}

/**
 * The `agent-sessions` management resource: every named session the
 * store knows, with its turn state and inbox depth, at
 * `GET /ops/agent-sessions` (filter with `?agent=`) and one session at
 * `GET /ops/agent-sessions/{session}`. Served under the ops
 * plugin's introspection tier when an ops mount exists; inert otherwise.
 *
 * A context with no deferral store has no sessions, and says so with an
 * empty collection rather than the RC5052 a dispatch would get, because a
 * listing is a question and not an attempt to hold a conversation.
 *
 * @internal
 */
const SESSIONS_RESOURCE = "agent-sessions";

/**
 * The management surface reads every session, whoever owns it.
 *
 * That is the deliberate operator privilege rather than a missing filter:
 * this resource is served under the ops mount's introspection tier, which
 * is already the credential that reads routes, indicators and the event
 * tail. A conversation belongs to the person who started it as far as
 * every protocol surface is concerned, and an operator holding the
 * management credential can see all of them, which is what makes
 * "who owns this session and where is it bound" an answerable question.
 */
const OPS_SCOPE: AgentSessionScope = "operator";

function registerSessionsResource(
  sessions: AgentSessionRuntime | undefined,
  ops: OpsService,
): void {
  ops.registerResource<AgentSessionSummary>({
    name: SESSIONS_RESOURCE,
    async list(query): Promise<OpsPage<AgentSessionSummary>> {
      if (sessions === undefined) return { items: [] };
      const agent = query["agent"];
      return sessions.summaries({
        scope: OPS_SCOPE,
        ...(agent !== undefined ? { agent } : {}),
        ...parsePageQuery(query),
      });
    },
    async describe(segments): Promise<AgentSessionSummary | undefined> {
      // One segment: a conversation is named by its id alone, so the
      // path is `/ops/agent-sessions/{session}` rather than a pair.
      if (segments.length !== 1) return undefined;
      const [session] = segments as [string];
      return sessions?.summary(session, OPS_SCOPE);
    },
  });
}

/**
 * Resolve every deferred tool while the boot can still fail cleanly.
 *
 * A tool naming a route that does not exist, or one carrying no
 * `.description()` or `.input()`, is a configuration error. Left to
 * dispatch it surfaces as a tool failure mid-conversation, at whatever hour
 * the agent first reaches for it. Resolved here it fails the startup that
 * introduced it.
 *
 * The result is memoized on the registry, so dispatch reuses this
 * resolution rather than repeating it.
 *
 * @throws RC5003 when a deferred entry cannot resolve
 */
function resolveLazyTools({ registry, tools }: AgentRun): void {
  for (const [id, entry] of registry.functions) {
    if (isLazyFn(entry)) {
      resolveFnOptions(tools, id, entry, registry.resolvedFunctions);
    }
  }
}

/**
 * Announce the registered agents and fns, so that generic observability
 * (the telemetry plugin / TUI) can list them even before any of them runs.
 * Inline agents are not announced here: they only exist at dispatch inside
 * a route and surface via their `route:agent:started` event instead.
 *
 * The events fire from `start()` rather than in `bind()` so the telemetry
 * plugin has already subscribed regardless of plugin install order. When
 * the application is never started there is nothing running to observe,
 * so emitting nothing is correct.
 */
function emitRegistrations(
  c: PluginContext,
  { registry, tools }: AgentRun,
): void {
  for (const [id, entry] of registry.agents) {
    c.emit("agent:registered", {
      agentId: id,
      description: entry.description,
      ...(typeof entry.model === "string" && { model: entry.model }),
      source: "registered",
    });
  }
  for (const [id, entry] of registry.functions) {
    // Resolved, so a route-backed tool announces the same shape a
    // hand-written one does. Every deferred entry resolved just before
    // this, so it reads the memoized result and cannot fail here.
    const declared = resolveFnOptions(
      tools,
      id,
      entry,
      registry.resolvedFunctions,
    );
    c.emit("agent:tool:registered", {
      toolName: id,
      description: declared.description,
      ...(Array.isArray(declared.tags) &&
        declared.tags.length > 0 && { tags: declared.tags }),
      source: "registered",
    });
  }
}
