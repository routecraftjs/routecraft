import { rcError } from "@routecraft/routecraft";
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalStringArray,
  readMarkdownDir,
  readMarkdownFile,
  requireString,
} from "../block/markdown.ts";
import { tools } from "./tools/index.ts";
import type { LlmModelId } from "../llm/types.ts";
import type { AgentRegisteredOptions } from "./types.ts";

/**
 * Frontmatter fields supported today. Claude's subagent schema covers
 * many more (`disallowedTools`, `permissionMode`, `mcpServers`,
 * `hooks`, `memory`, `background`, `effort`, `isolation`, `color`,
 * `initialPrompt`, ...) which we will add incrementally as the
 * underlying features land. Any other key in the frontmatter throws
 * `RC5003` "not yet supported" at load so a misspelt key never silently
 * disappears.
 */
const SUPPORTED_AGENT_KEYS = new Set([
  "name",
  "description",
  "model",
  "maxTurns",
  "tools",
  "principal",
]);

/**
 * Per-agent override layered on top of the markdown frontmatter. Only
 * the fields that make sense to override at config time are exposed
 * here. Lifecycle fields like `validate` and `onDelta` belong in code
 * (markdown frontmatter cannot express closures) so set those on the
 * agent at the call site or via `agentPlugin({ defaultOptions })`.
 *
 * `principal` accepts the full {@link AgentRegisteredOptions.principal}
 * shape here (`boolean | AgentPrincipalRenderer`). Frontmatter can only
 * carry the boolean form; reach for the override (or
 * `agentPlugin({ defaultOptions })`) when an agent needs the
 * function-renderer form that YAML cannot express.
 */
export interface AgentMarkdownOverride extends Partial<
  Pick<
    AgentRegisteredOptions,
    "description" | "model" | "maxTurns" | "tools" | "principal" | "blocks"
  >
> {
  /**
   * Replace the system prompt loaded from the markdown body. Useful
   * when a deployment wants to swap a tone or constraint without
   * editing the source file.
   */
  system?: string;
}

/**
 * Convert a parsed markdown file into an `AgentRegisteredOptions`.
 * Validates that frontmatter `name` matches the filename so the
 * registry id is unambiguous; throws on unsupported frontmatter
 * fields and on empty body so an agent never lands with a hollow
 * system prompt.
 *
 * @internal
 */
function toAgent(
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
  source: string,
): { name: string; agent: AgentRegisteredOptions } {
  for (const key of Object.keys(frontmatter)) {
    if (!SUPPORTED_AGENT_KEYS.has(key)) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": frontmatter field "${key}" is not yet supported. Currently supported fields: ${[...SUPPORTED_AGENT_KEYS].sort().join(", ")}.`,
      });
    }
  }
  const name = requireString(frontmatter["name"], "name", source);
  if (name !== filename) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter "name" ("${name}") must match the filename ("${filename}"). Rename one or the other.`,
    });
  }
  const description = requireString(
    frontmatter["description"],
    "description",
    source,
  );
  if (body.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": agent body is empty. The body becomes the agent's system prompt; an empty system prompt is rejected at dispatch.`,
    });
  }
  const modelRaw = frontmatter["model"];
  if (modelRaw !== undefined && typeof modelRaw !== "string") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter "model" must be a string of the form "provider:model" (e.g. "anthropic:claude-sonnet-4-6").`,
    });
  }
  if (typeof modelRaw === "string" && !modelRaw.includes(":")) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter "model" ("${modelRaw}") must use the full "provider:model" form. Bare model aliases like "sonnet" / "opus" / "haiku" are not yet supported by the markdown loader.`,
    });
  }
  const maxTurns = optionalPositiveInt(
    frontmatter["maxTurns"],
    "maxTurns",
    source,
  );
  const toolNames = optionalStringArray(frontmatter["tools"], "tools", source);
  // Frontmatter carries only the boolean form; the function-renderer
  // form is a closure YAML cannot express and is supplied via the
  // override map or agentPlugin({ defaultOptions }).
  const principal = optionalBoolean(
    frontmatter["principal"],
    "principal",
    source,
  );
  const agent: AgentRegisteredOptions = {
    description,
    system: body,
  };
  if (modelRaw) agent.model = modelRaw as LlmModelId;
  if (maxTurns !== undefined) agent.maxTurns = maxTurns;
  if (toolNames !== undefined) agent.tools = tools(toolNames);
  if (principal !== undefined) agent.principal = principal;
  return { name, agent };
}

/**
 * Apply caller-supplied overrides on top of the agent loaded from
 * markdown. Replaces, never extends: an explicit `tools` override
 * replaces the markdown's tool list entirely (matches the
 * agent-level tool inheritance contract).
 *
 * @internal
 */
function applyOverride(
  agent: AgentRegisteredOptions,
  override: AgentMarkdownOverride | undefined,
): AgentRegisteredOptions {
  if (!override) return agent;
  const out: AgentRegisteredOptions = { ...agent };
  if (override.description !== undefined)
    out.description = override.description;
  if (override.model !== undefined) out.model = override.model;
  if (override.maxTurns !== undefined) out.maxTurns = override.maxTurns;
  if (override.tools !== undefined) out.tools = override.tools;
  if (override.principal !== undefined) out.principal = override.principal;
  if (override.blocks !== undefined) out.blocks = override.blocks;
  if (override.system !== undefined) out.system = override.system;
  return out;
}

/**
 * Load agents from a markdown file or directory.
 *
 * - If `path` points to a directory, every `.md` file directly under
 *   it becomes one agent. The filename (without `.md`) is the agent
 *   name and must match the frontmatter `name`.
 * - If `path` points to a single `.md` file, the file becomes one
 *   agent keyed by its filename.
 *
 * Frontmatter mirrors a deliberately narrow subset of Claude's
 * subagent schema:
 *
 * | Field         | Required | Maps to                                |
 * | ------------- | -------- | -------------------------------------- |
 * | `name`        | yes      | record key + agent id                  |
 * | `description` | yes      | `AgentRegisteredOptions.description`   |
 * | `model`       | no       | `AgentRegisteredOptions.model` (full   |
 * |               |          | `provider:model` form only)            |
 * | `maxTurns`    | no       | `AgentRegisteredOptions.maxTurns`      |
 * | `tools`       | no       | `tools(stringArray)`                   |
 * | `principal`   | no       | `AgentRegisteredOptions.principal`     |
 * |               |          | (boolean only; renderer via override)  |
 *
 * Body of the file becomes `system`. Other Claude subagent fields
 * (`disallowedTools`, `permissionMode`, `mcpServers`, `hooks`,
 * `memory`, `background`, `effort`, `isolation`, `color`,
 * `initialPrompt`, ...) throw `RC5003` "not yet supported" at load
 * and will land in follow-up stories as the runtime gains the
 * underlying features.
 *
 * Pass `overrides` keyed by agent name to replace any of
 * `description` / `model` / `maxTurns` / `tools` / `blocks` /
 * `principal` / `system` per agent without editing the markdown
 * source. `blocks` is override-only because YAML cannot express the
 * function-form resolvers a block may carry.
 *
 * Returns a `Record<name, AgentRegisteredOptions>` ready to spread
 * into `agentPlugin({ agents: agents("./agents") })`.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   agents: agents("./agents", {
 *     researcher: { maxTurns: 30 },
 *   }),
 * });
 * ```
 */
export async function agents(
  path: string,
  overrides: Record<string, AgentMarkdownOverride> = {},
): Promise<Record<string, AgentRegisteredOptions>> {
  const out: Record<string, AgentRegisteredOptions> = {};
  const docs = path.endsWith(".md")
    ? [await readMarkdownFile(path)]
    : await readMarkdownDir(path);
  for (const doc of docs) {
    const { name, agent } = toAgent(
      doc.filename,
      doc.frontmatter,
      doc.body,
      doc.path,
    );
    out[name] = applyOverride(agent, overrides[name]);
  }
  for (const name of Object.keys(overrides)) {
    if (!(name in out)) {
      throw rcError("RC5003", undefined, {
        message: `agents("${path}"): override for "${name}" but no agent with that name was loaded from disk.`,
      });
    }
  }
  return out;
}
