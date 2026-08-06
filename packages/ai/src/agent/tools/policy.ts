import type { Tag } from "@routecraft/routecraft";
import type { McpToolAnnotations } from "../../mcp/types.ts";

/**
 * Where a resolved tool came from. Set by the resolver, never by user
 * config, so a policy rule can trust it as provenance rather than as a
 * self-declared label.
 *
 * The `direct` arm covers both spellings of the same thing: a
 * `Direct(<routeId>)` reference and a `directTool(routeId)` registered
 * under a fn id. Aliasing a capability into the fn registry changes the
 * name the model sees, not what the tool reaches, so classifying the
 * alias as `fn` would make the alias a policy bypass.
 */
export type AgentToolSource =
  | { readonly kind: "fn"; readonly id: string }
  | { readonly kind: "direct"; readonly routeId: string }
  | {
      readonly kind: "mcp";
      readonly server: string;
      readonly tool: string;
      /**
       * Raw hints exactly as the remote declared them. An absent key
       * means the server was silent, which is NOT the same as the hint
       * being false: the MCP specification assigns per-hint defaults,
       * and `destructiveHint` defaults to true when absent. Consult
       * this rather than `tags` when the difference matters.
       */
      readonly annotations?: McpToolAnnotations;
    }
  | {
      /**
       * A framework-synthesised block loader. Present so every resolved
       * tool declares its provenance, but never seen by a policy rule:
       * loader tools are merged in after policy evaluation and are
       * deliberately out of scope (they assemble context, they do not
       * grant reach).
       */
      readonly kind: "block";
      readonly name: string;
    };

/**
 * The tool kinds a {@link AgentToolPolicy} can govern. Excludes
 * `block`, which is framework machinery rather than a granted
 * capability.
 */
export type AgentToolPolicyKind = "fn" | "direct" | "mcp";

/**
 * Read-only view of a tool handed to a policy rule.
 *
 * Deliberately not the `ResolvedTool` itself: `handler` stays out of
 * user policy code, so a rule cannot wrap, mutate, or invoke the thing
 * it is deciding about. New metadata can arrive here as optional fields
 * without breaking existing predicates.
 */
export interface AgentToolDescriptor {
  /** The LLM-facing tool name, already in its final wire form. */
  readonly name: string;
  /** Description the model would be shown. */
  readonly description: string;
  /** Tags from the underlying registration, empty when it carries none. */
  readonly tags: readonly Tag[];
  /** Resolver-set provenance. */
  readonly source: AgentToolSource;
}

/**
 * Context in which a rule is being evaluated.
 */
export interface AgentToolPolicyContext {
  /**
   * The registered agent's id, or `undefined` for an inline agent.
   *
   * Present for logging and diagnostics. Rules must not branch on it:
   * inline agents have no id, so an identity-keyed rule has no
   * defensible default for them (denying breaks every inline agent,
   * allowing creates a trivial bypass). If per-agent policy is wanted
   * later, the missing ingredient is provenance carried through agent
   * registration, not this field.
   */
  readonly agentId: string | undefined;
}

/**
 * A single admission rule. `true` admits every tool of the kind,
 * `false` denies every tool of the kind, and a predicate decides per
 * tool.
 */
export type AgentToolRule =
  | boolean
  | ((tool: AgentToolDescriptor, ctx: AgentToolPolicyContext) => boolean);

/**
 * Repository-wide admission rules for the agent tool surface, one entry
 * per tool kind.
 *
 * **Absent `toolPolicy` means no policy at all: every tool is
 * admitted.** Once `toolPolicy` is present it becomes an allowlist, and
 * a kind with no entry is denied. That asymmetry is deliberate: it is
 * the only shape that leaves existing contexts untouched while failing
 * closed for anyone who opts in. One consequence worth knowing: a
 * future framework release that adds a fourth tool kind narrows an
 * existing policy rather than widening it, which is the safe direction,
 * and is why denial always logs.
 *
 * Multiple `agentPlugin` installs compose with AND. A tool is admitted
 * only when every installed policy admits it, so adding a plugin can
 * only ever narrow the surface.
 *
 * @example Deny external MCP client tools outright
 * ```ts
 * agentPlugin({
 *   agents: await agents("./agents"),
 *   toolPolicy: {
 *     fn: true,
 *     direct: true,
 *     mcp: false, // reachable only by wrapping one in a capability
 *   },
 * });
 * ```
 *
 * @example Refine with predicates
 * ```ts
 * agentPlugin({
 *   toolPolicy: {
 *     fn: true,
 *     direct: (tool) => !tool.tags.includes("experimental"),
 *     mcp: (tool) => tool.source.kind === "mcp" && tool.source.server === "docs",
 *   },
 * });
 * ```
 */
export interface AgentToolPolicy {
  /** Rule for in-process fns registered via `agentPlugin({ functions })`. */
  fn?: AgentToolRule;
  /**
   * Rule for capabilities in the capability registry, reached via
   * `Direct(<routeId>)` or a `directTool` alias.
   *
   * Named for the capability registry rather than for routes, because
   * that registry is what the agent surface can actually reach. A route
   * sourced only from `http()` or `mcp()` never registers a capability,
   * so it is not addressable as an agent tool in the first place and a
   * rule here would give a false impression of governing it.
   */
  direct?: AgentToolRule;
  /** Rule for tools discovered from external MCP clients. */
  mcp?: AgentToolRule;
}

/**
 * Evaluate one rule against one tool.
 *
 * @internal
 */
function ruleAdmits(
  rule: AgentToolRule | undefined,
  tool: AgentToolDescriptor,
  ctx: AgentToolPolicyContext,
): boolean {
  // A kind with no entry under a present policy is denied: the policy
  // is an allowlist once it exists.
  if (rule === undefined) return false;
  if (typeof rule === "boolean") return rule;
  return rule(tool, ctx) === true;
}

/**
 * Decide whether every installed policy admits `tool`. Composition is
 * AND, so installing another `agentPlugin` can only narrow the surface.
 *
 * Block-sourced tools are never passed here; the caller applies the
 * policy to the user tool list only.
 *
 * @internal
 */
export function policiesAdmit(
  policies: readonly AgentToolPolicy[],
  tool: AgentToolDescriptor,
  ctx: AgentToolPolicyContext,
): boolean {
  if (policies.length === 0) return true;
  const kind = tool.source.kind;
  if (kind === "block") return true;
  for (const policy of policies) {
    if (!ruleAdmits(policy[kind], tool, ctx)) return false;
  }
  return true;
}
