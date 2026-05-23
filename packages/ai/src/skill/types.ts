import type { ResolveKey } from "@routecraft/routecraft";

/**
 * Store key for the registry of skills installed by
 * `agentPlugin({ skills })`. Resolved at agent dispatch time so an
 * agent that lists `skills: ["X"]` gets the corresponding skill
 * content concatenated into its system prompt.
 * @internal
 */
export const ADAPTER_SKILL_REGISTRY = Symbol.for(
  "routecraft.adapter.skill.registry",
);

/**
 * A reusable, portable instruction set that an agent loads into its
 * system prompt at dispatch time. The full content is injected
 * verbatim, not exposed as a tool the agent can choose to invoke; this
 * matches the Claude subagent skills semantic ("inject the skill
 * content, do not make it tool-callable").
 *
 * Skills are framework-portable: any provider can consume one because
 * a skill is just text. Provider-specific hosted skills (e.g. the
 * Anthropic hosted-skills feature surfaced through `@ai-sdk/anthropic`)
 * are out of scope for this primitive and will land separately.
 */
export interface Skill {
  /** Unique skill name. Matches the registry key and the filename when loaded via `skills(path)`. */
  name: string;
  /** Human-readable description. Surfaces in observability and in error messages when a skill lookup fails. */
  description: string;
  /** Full skill content. Concatenated into the system prompt of every agent that references the skill by name. */
  content: string;
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_SKILL_REGISTRY]: Map<string, Skill>;
  }
}

/**
 * Registry for configured skills.
 *
 * Keys are skill names (matching the record keys in
 * `agentPlugin({ skills })`). Populate via declaration merging to
 * narrow `AgentOptions.skills` and `AgentRegisteredOptions.skills`
 * entries to the set of registered skill names.
 *
 * @example
 * ```typescript
 * declare module "@routecraft/ai" {
 *   interface SkillRegistry {
 *     "web-search": true;
 *     "cite-sources": true;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface populated via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface SkillRegistry {}

/**
 * Resolved skill name type. When `SkillRegistry` is populated,
 * constrains to the union of declared names. Falls back to `string`
 * when the registry is empty.
 */
export type RegisteredSkillName = ResolveKey<SkillRegistry>;
