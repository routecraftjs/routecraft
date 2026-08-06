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
 * The tool kinds a {@link AgentToolPolicy} can govern. Derived from
 * {@link AgentToolSource} rather than restated, so adding a source kind
 * cannot silently leave the policy surface behind. Excludes `block`,
 * which is framework machinery rather than a granted capability.
 */
export type AgentToolPolicyKind = Exclude<AgentToolSource["kind"], "block">;

/**
 * Presence map over the governable kinds, existing purely so the
 * compiler enforces completeness.
 *
 * `satisfies Record<AgentToolPolicyKind, true>` fails when a key is
 * MISSING, which a `satisfies readonly AgentToolPolicyKind[]` on an
 * array does not: an array of valid kinds satisfies that constraint
 * whether or not it lists them all. Adding a kind to
 * {@link AgentToolSource} therefore breaks the build here, which is the
 * point, because the alternative is a validator that silently stops
 * recognising a kind the type system already governs.
 *
 * @internal
 */
const AGENT_TOOL_POLICY_KIND_PRESENCE = {
  fn: true,
  direct: true,
  mcp: true,
} as const satisfies Record<AgentToolPolicyKind, true>;

/**
 * The governable kinds as a runtime value, for validators that need to
 * enumerate them. Derived from
 * {@link AGENT_TOOL_POLICY_KIND_PRESENCE} so it cannot drift from the
 * type.
 *
 * @internal
 */
export const AGENT_TOOL_POLICY_KINDS = Object.keys(
  AGENT_TOOL_POLICY_KIND_PRESENCE,
) as readonly AgentToolPolicyKind[];

/**
 * The provenance arms a policy rule can actually be handed. Excludes
 * `block`: loader tools are merged in after policy evaluation, so no
 * predicate ever sees one, and leaving the arm in the union would force
 * every predicate to carry a dead `kind` guard to reach its own fields.
 */
export type AgentToolPolicySource = Extract<
  AgentToolSource,
  { kind: AgentToolPolicyKind }
>;

/**
 * Read-only view of a tool handed to a policy rule.
 *
 * Deliberately not the `ResolvedTool` itself: `handler` stays out of
 * user policy code, so a rule cannot wrap, mutate, or invoke the thing
 * it is deciding about. New metadata can arrive here as optional fields
 * without breaking existing predicates.
 */
export interface AgentToolDescriptor<
  K extends AgentToolPolicyKind = AgentToolPolicyKind,
> {
  /** The LLM-facing tool name, already in its final wire form. */
  readonly name: string;
  /** Description the model would be shown. */
  readonly description: string;
  /** Tags from the underlying registration, empty when it carries none. */
  readonly tags: readonly Tag[];
  /**
   * Resolver-set provenance, narrowed to the kind whose rule is being
   * evaluated. An `mcp` rule therefore reads `tool.source.server`
   * directly, with no `kind` guard to satisfy the type checker.
   */
  readonly source: Extract<AgentToolPolicySource, { kind: K }>;
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
export type AgentToolRule<K extends AgentToolPolicyKind = AgentToolPolicyKind> =
  | boolean
  | ((tool: AgentToolDescriptor<K>, ctx: AgentToolPolicyContext) => boolean);

/**
 * Repository-wide admission rules for the agent tool surface, one entry
 * per tool kind.
 *
 * **Absent `toolPolicy` means no policy at all: every tool is
 * admitted**, so existing contexts are untouched. Once `toolPolicy` is
 * present it is an allowlist and every kind must be decided.
 *
 * Every key is required, deliberately. An optional key would read the
 * way `?` reads everywhere else in TypeScript, "omit it and get the
 * default", when the effective default here is total denial. Writing
 * only the line you care about:
 *
 * ```ts
 * agentPlugin({ toolPolicy: { mcp: false } }); // does not compile
 * ```
 *
 * would otherwise strip every fn and every capability from every agent
 * in the repository, with no diff signal and nothing to notice but a
 * warn line per dropped tool. Requiring all three turns that into a
 * compile error naming the kinds you forgot. It also means a future
 * release adding a fourth kind breaks the build rather than silently
 * narrowing what you already deployed.
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
 *     mcp: (tool) => tool.source.server === "docs",
 *   },
 * });
 * ```
 */
export type AgentToolPolicy = {
  /**
   * Rule for the tools of this kind.
   *
   * - `fn`: in-process fns registered via `agentPlugin({ functions })`.
   * - `direct`: capabilities in the capability registry, reached via
   *   `Direct(<routeId>)` or a `directTool` alias. Named for the
   *   capability registry rather than for routes, because that registry
   *   is what the agent surface can actually reach: a route sourced
   *   only from `http()` or `mcp()` never registers a capability, so it
   *   is not addressable as an agent tool and a rule here would give a
   *   false impression of governing it.
   * - `mcp`: tools discovered from external MCP clients.
   */
  [K in AgentToolPolicyKind]: AgentToolRule<K>;
};

/**
 * Reports a predicate that threw. Supplied by the caller so the failure
 * can be logged with the context's logger; the policy module itself
 * stays free of logging concerns.
 *
 * @internal
 */
export type AgentToolRuleErrorReporter = (
  tool: AgentToolDescriptor,
  cause: unknown,
) => void;

/**
 * The outcome of evaluating a policy against one tool. `reported` says
 * whether the denial has already been surfaced through
 * {@link AgentToolRuleErrorReporter}, so the caller can log the routine
 * denial line without duplicating a failure it has already described in
 * more detail.
 *
 * @internal
 */
export interface AgentToolVerdict {
  readonly admitted: boolean;
  readonly reported: boolean;
}

/**
 * Evaluate one rule against one tool.
 *
 * A predicate that throws denies the tool rather than propagating. The
 * alternative would contradict the documented contract twice over: a
 * policy is meant to fail closed, and a denial is meant never to abort
 * a dispatch. Letting the throw escape would do the opposite of both,
 * turning one bad predicate into a total outage for every agent that
 * lists a tool of that kind. The throw is still surfaced through
 * `onRuleError` at error level, because a throwing predicate is a bug
 * in the policy, not a decision.
 *
 * @internal
 */
function ruleAdmits(
  rule: AgentToolRule | undefined,
  tool: AgentToolDescriptor,
  ctx: AgentToolPolicyContext,
  onRuleError: AgentToolRuleErrorReporter | undefined,
): AgentToolVerdict {
  // A kind with no entry under a present policy is denied: the policy
  // is an allowlist once it exists. The type requires every key, so
  // this is only reachable from JavaScript or a cast.
  if (rule === undefined) return { admitted: false, reported: false };
  if (typeof rule === "boolean") {
    return { admitted: rule, reported: false };
  }
  try {
    return { admitted: rule(tool, ctx) === true, reported: false };
  } catch (cause) {
    onRuleError?.(tool, cause);
    // Reported here, so the caller does not log a second, blander line
    // for the same tool and the same outcome.
    return { admitted: false, reported: true };
  }
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
  onRuleError?: AgentToolRuleErrorReporter,
): AgentToolVerdict {
  if (policies.length === 0) return { admitted: true, reported: false };
  const kind = (tool.source as AgentToolSource | undefined)?.kind;
  // Loader tools are exempt and are also merged in after this runs, so
  // this arm is belt-and-braces rather than the primary guard.
  if (kind === "block") return { admitted: true, reported: false };
  // Provenance is resolver-set, so an absent or unrecognised kind means
  // a hand-built `ResolvedTool` from outside the type contract. Deny it
  // rather than dereferencing undefined and taking down the dispatch:
  // an allowlist cannot admit what it cannot classify. `reported` stays
  // false so the caller's denial line names the tool.
  if (!AGENT_TOOL_POLICY_KINDS.includes(kind as AgentToolPolicyKind)) {
    return { admitted: false, reported: false };
  }
  for (const policy of policies) {
    // The rule is typed for its own kind, so it declares a narrower
    // descriptor than the wide one this function holds. The narrowing is
    // real: `kind` was read off `tool.source`, so the descriptor being
    // passed IS of that kind. TypeScript cannot see that link through
    // the index access, and function parameters are contravariant, so
    // the two-step cast is the honest way to state it. This is the only
    // cast in the policy path and it sits one line below the check that
    // justifies it.
    const rule = policy[kind as AgentToolPolicyKind] as unknown as
      AgentToolRule | undefined;
    const verdict = ruleAdmits(rule, tool, ctx, onRuleError);
    if (!verdict.admitted) return verdict;
  }
  return { admitted: true, reported: false };
}
