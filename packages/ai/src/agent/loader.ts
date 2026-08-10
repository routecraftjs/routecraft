import { logger, rcError } from "@routecraft/routecraft";
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalStringArray,
  readMarkdownSource,
  requireString,
  type ParsedMarkdown,
} from "../block/markdown.ts";
import { tools } from "./tools/index.ts";
import type { LlmModelId } from "../llm/types.ts";
import type { AgentRegisteredOptions } from "./types.ts";

/**
 * Filename that turns a directory under `agents/` into a single agent
 * bundle. The directory is the agent's home: it holds the definition
 * and any assets scoped to that agent, and is never descended into for
 * further agents.
 *
 * @internal
 */
export const AGENT_BUNDLE_FILENAME = "AGENT.md";

/**
 * Directory name reserved inside `agents/` at every depth. It belongs
 * to the enclosing agent bundle and is loaded by `skills()`, never by
 * the agent walk.
 *
 * @internal
 */
export const AGENT_RESERVED_DIRECTORIES = ["skills"] as const;

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
  "skills",
]);

/**
 * Fields whose values are not YAML-expressible today (function-form block
 * resolvers, Standard Schema objects with a live `validate` function).
 * They get a pointed error instead of the generic "not yet supported"
 * one: the override map is their home unless a serializable form (say, a
 * JSON Schema string for `output`) is ever adopted.
 */
const OVERRIDE_ONLY_AGENT_KEYS = new Set(["blocks", "output"]);

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
 *
 * `output` is override-only, mirroring `blocks`: a Standard Schema is a
 * live object with a `validate` function, so YAML frontmatter can never
 * express one. Supply the schema here to give a markdown-defined agent
 * structured output (the parsed value lands on `AgentResult.output`).
 */
export interface AgentMarkdownOverride extends Partial<
  Pick<
    AgentRegisteredOptions,
    | "description"
    | "model"
    | "maxTurns"
    | "tools"
    | "principal"
    | "blocks"
    | "output"
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
 * One agent as it was found on disk, before per-agent overrides are
 * applied. Carries the location the definition came from so a caller
 * that composes further content (the `craft start` discoverer reading
 * a bundle's `skills/` folder, a startup log naming each agent's
 * source) does not have to walk the tree a second time.
 *
 * @internal
 */
export interface LoadedAgentFile {
  /** Agent id, taken from the frontmatter `name` field. */
  name: string;
  /** Options ready to register, minus any caller-supplied override. */
  agent: AgentRegisteredOptions;
  /** Absolute path of the markdown file the agent was read from. */
  source: string;
  /**
   * Absolute path of the bundle directory when the agent was defined
   * as `<name>/AGENT.md`. Absent for a flat `<name>.md` file, whose
   * base directory is `dirname(source)`.
   */
  bundleDirectory?: string;
  /**
   * The `skills:` frontmatter list exactly as authored, unresolved.
   * Entries are local paths or `npm:` package refs; resolving them
   * against disk and composing the result into the agent's blocks is
   * the caller's job, because a local path is relative to the agent
   * file and the composition order involves sources this loader knows
   * nothing about.
   */
  skills?: readonly string[];
}

/**
 * Convert a parsed markdown file into an `AgentRegisteredOptions`.
 * Identity comes from the frontmatter `name` field alone: the filename
 * and the directory path are grouping, not identity, which is what
 * lets an existing Claude Code `agents/` tree load unmodified. The one
 * exception is a bundle (`<name>/AGENT.md`), where the directory is
 * the agent's home and a mismatch would make the tree unreadable.
 *
 * Throws on unsupported frontmatter fields and on an empty body so an
 * agent never lands with a hollow system prompt.
 *
 * @internal
 */
function toAgent(doc: ParsedMarkdown): LoadedAgentFile {
  const { frontmatter, body, path: source } = doc;
  // Validate `name` before the key sweep: it is the override map's key,
  // so the "supply it via the override map" hint below would otherwise
  // have to guess one and send the author to a key that map rejects.
  const name = requireString(frontmatter["name"], "name", source);
  for (const key of Object.keys(frontmatter)) {
    if (OVERRIDE_ONLY_AGENT_KEYS.has(key)) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": frontmatter field "${key}" is override-only; YAML cannot express its value. Supply it via the override map instead: agents(path, { ${JSON.stringify(name)}: { ${key}: ... } }).`,
      });
    }
    if (!SUPPORTED_AGENT_KEYS.has(key)) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": frontmatter field "${key}" is not yet supported. Currently supported fields: ${[...SUPPORTED_AGENT_KEYS].sort().join(", ")}.`,
      });
    }
  }
  if (doc.bundleDirectory !== undefined && name !== doc.filename) {
    throw rcError("RC5003", undefined, {
      message: `Agent bundle "${doc.bundleDirectory}": frontmatter "name" ("${name}") in ${AGENT_BUNDLE_FILENAME} must match the bundle directory name ("${doc.filename}"). Rename one or the other.`,
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
  const skillRefs = optionalStringArray(
    frontmatter["skills"],
    "skills",
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
  const loaded: LoadedAgentFile = { name, agent, source };
  if (doc.bundleDirectory !== undefined)
    loaded.bundleDirectory = doc.bundleDirectory;
  if (skillRefs !== undefined) loaded.skills = skillRefs;
  return loaded;
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
  if (override.output !== undefined) out.output = override.output;
  if (override.system !== undefined) out.system = override.system;
  return out;
}

/**
 * Walk an agent markdown file or directory and return one entry per
 * agent found, in path order, with the source location attached.
 *
 * This is the layout rule for `agents/`, and it lives here rather than
 * in the CLI so a programmatic caller and `craft start` walk the tree
 * the same way. See {@link agents} for the frontmatter contract.
 *
 * @internal
 */
export async function loadAgentFiles(path: string): Promise<LoadedAgentFile[]> {
  const docs = await readMarkdownSource(path, {
    sentinelFilename: AGENT_BUNDLE_FILENAME,
    recursive: true,
    reservedDirectories: AGENT_RESERVED_DIRECTORIES,
  });
  const out: LoadedAgentFile[] = [];
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const loaded = toAgent(doc);
    const prior = seen.get(loaded.name);
    if (prior !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `agents("${path}"): duplicate agent name "${loaded.name}" declared in both "${prior}" and "${loaded.source}". Agent identity comes from the frontmatter "name" field, so two files anywhere in the tree cannot share one; rename or remove one.`,
      });
    }
    seen.set(loaded.name, loaded.source);
    out.push(loaded);
  }
  return out;
}

/**
 * Load agents from a markdown file or directory.
 *
 * A directory is walked recursively, matching Claude Code's
 * `.claude/agents/` convention, so an existing tree drops in
 * unmodified. Three layout rules apply:
 *
 * - **Flat file.** Any `.md` file, at any depth, is one agent.
 *   Identity is the frontmatter `name`; the filename and the
 *   directories above it are grouping and carry no identity.
 * - **Bundle.** A directory holding `AGENT.md` is exactly one agent
 *   and is not descended into for further agents. This is the one
 *   place the relaxed filename rule does not apply: the frontmatter
 *   `name` must match the bundle directory name, because the
 *   directory is the agent's home.
 * - **Reserved.** A directory named `skills` is never scanned for
 *   agents at any depth. It belongs to the enclosing bundle and is
 *   loaded by `skills()`.
 *
 * A single `.md` path loads that one file. Duplicate `name` values
 * anywhere in the tree throw `RC5003` naming both files, rather than
 * one definition silently shadowing the other.
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
 * | `skills`      | no       | declaration consumed by `craft start`  |
 *
 * Body of the file becomes `system`. Other Claude subagent fields
 * (`disallowedTools`, `permissionMode`, `mcpServers`, `hooks`,
 * `memory`, `background`, `effort`, `isolation`, `color`,
 * `initialPrompt`, ...) throw `RC5003` "not yet supported" at load
 * and will land in follow-up stories as the runtime gains the
 * underlying features.
 *
 * `skills` is validated as a list of strings and otherwise passed
 * through: resolving a ref into blocks needs the house skill folder
 * and the bundle folder, neither of which this loader is given. A
 * direct `agents()` call therefore records the declaration and loads
 * no skills from it; `craft start` is what resolves and composes it.
 * Attach skills yourself with the `blocks` override when calling
 * `agents()` by hand.
 *
 * Pass `overrides` keyed by agent name to replace any of
 * `description` / `model` / `maxTurns` / `tools` / `blocks` /
 * `principal` / `output` / `system` per agent without editing the
 * markdown source. `blocks` and `output` are override-only because
 * YAML cannot express the function-form resolvers a block may carry,
 * nor a Standard Schema (a live object with a `validate` function).
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
  // Null-prototype map so a frontmatter `name` like `__proto__` or
  // `toString` cannot collide with Object.prototype (the `in` check
  // below would otherwise pass for keys that were never loaded, and
  // an assignment to `__proto__` would mutate the prototype).
  const out = Object.create(null) as Record<string, AgentRegisteredOptions>;
  for (const loaded of await loadAgentFiles(path)) {
    if (loaded.skills !== undefined) {
      // Debug rather than warn, and unconditional. This call never
      // resolves the key, but a config that calls agents() and then
      // boots under the project runtime does get it resolved moments
      // later, so warning here would cry wolf on the common path. An
      // override is no signal either way: it may set blocks that have
      // nothing to do with the declared skills.
      logger.debug(
        `Markdown file "${loaded.source}": frontmatter "skills" needs the house and bundle folders to resolve, which agents() is not given, so this call did not load it. The project runtime resolves it; from a direct agents() call, attach skills with the "blocks" override.`,
      );
    }
    out[loaded.name] = applyOverride(loaded.agent, overrides[loaded.name]);
  }
  for (const name of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(out, name)) {
      throw rcError("RC5003", undefined, {
        message: `agents("${path}"): override for "${name}" but no agent with that name was loaded from disk.`,
      });
    }
  }
  return out;
}
