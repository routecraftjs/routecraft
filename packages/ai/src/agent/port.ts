import { port } from "@routecraft/routecraft";
import type { FnOptions } from "../fn/types.ts";
import type { AgentSessionRuntime } from "./session/runtime.ts";
import type { AgentToolPolicy } from "./tools/policy.ts";
import type { FnEntry } from "./tools/types.ts";
import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";

/**
 * One contribution to the agent registry: what a single `agentPlugin()`
 * install, or the `agent` config key, adds.
 */
export interface AgentContribution {
  readonly agents?: Readonly<Record<string, AgentRegisteredOptions>>;
  readonly functions?: Readonly<Record<string, FnEntry>>;
  readonly defaultOptions?: AgentDefaultOptions;
  readonly toolPolicy?: AgentToolPolicy;
}

/**
 * What the agent runtime provides: every registered agent, function,
 * default and tool policy in the application, and the session runtime the
 * agents hold their conversations in.
 *
 * Contributions compose rather than overwrite. A duplicate agent or
 * function id, or a default set twice, is refused with `RC5003`; tool
 * policies are kept side by side and a tool must satisfy all of them.
 */
export interface AgentRegistry {
  /** Registered agents, by id, in contribution order. */
  readonly agents: ReadonlyMap<string, AgentRegisteredOptions>;
  /** Registered functions, by id, in contribution order. */
  readonly functions: ReadonlyMap<string, FnEntry>;
  /** The merged application-level defaults, if any contribution set one. */
  readonly defaults: AgentDefaultOptions | undefined;
  /** Every contributed tool policy; composed with AND at dispatch. */
  readonly toolPolicies: readonly AgentToolPolicy[];
  /**
   * Add one contribution, applying the composition rules. In `bind` only:
   * whatever read the contributions during bind has already used them.
   *
   * @throws RC5003 for an invalid entry, a duplicate id, or a default set twice
   * @throws RC1110 once the application froze
   */
  contribute(contribution: AgentContribution): void;
  /**
   * The session runtime, opened when the agent runtime binds and stopped
   * with the session store it writes to.
   *
   * @throws RC5052 when no plugin provides continuations, which a session
   *   needs to store a turn between messages
   */
  sessions(): AgentSessionRuntime;
  /**
   * Resolved deferred functions by id, so a tool resolved at start is not
   * resolved again at dispatch.
   *
   * @internal
   */
  readonly resolvedFunctions: Map<string, FnOptions>;
}

/** The agent registry the agent runtime plugin provides. */
export const AGENTS = port<AgentRegistry>("routecraft.ai.agents@1");
