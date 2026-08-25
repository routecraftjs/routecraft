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
import type { ToolSelection } from "./tools/selection.ts";
import { toolNameOf } from "./tools/specifier.ts";
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
 * Frontmatter fields this loader maps. Claude's subagent schema covers
 * more (`permissionMode`, `mcpServers`, `hooks`, `memory`,
 * `background`, `effort`, `isolation`, `color`, `initialPrompt`, ...)
 * which we will add as the underlying features land. Any other key is
 * ignored with a warning rather than throwing: tolerance is what keeps
 * "drop your `.claude/agents/` tree in unchanged" true, and a file
 * written for a harness that grows a new key must not stop booting
 * this one.
 */
const SUPPORTED_AGENT_KEYS = new Set([
  "name",
  "description",
  "model",
  "maxTurns",
  "tools",
  "disallowedTools",
  "principal",
  "skills",
]);

/**
 * Claude model aliases mapped to the full `provider:model` form. The
 * targets are pinned rather than "whatever is newest", because an
 * agent whose model silently changes under it is not reproducible;
 * write the full form to pick a different version.
 */
const MODEL_ALIASES: Record<string, LlmModelId> = {
  opus: "anthropic:claude-opus-4-7" as LlmModelId,
  sonnet: "anthropic:claude-sonnet-4-6" as LlmModelId,
  haiku: "anthropic:claude-haiku-4-5" as LlmModelId,
};

/**
 * Claude Code's built-in tool names. A reference to one of these that
 * this runtime does not provide is dropped with a warning instead of
 * failing the load, so an agent file written for a coding harness
 * still boots here with its remaining tools. A genuinely unknown name
 * is still a hard error, because that is a typo or a missing
 * registration rather than a known gap.
 *
 * The check runs against the live catalog, so the moment Routecraft
 * registers a fn under one of these names (`WebFetch` in #341,
 * `WebSearch` in #342, `Bash` in #343) it resolves normally and no
 * entry has to be removed from this list.
 */
const CLAUDE_BUILTIN_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "Edit",
  "Glob",
  "Grep",
  "KillShell",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
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
 * Read a tool reference list from frontmatter. Accepts the YAML array
 * form and Claude Code's comma-separated string
 * (`tools: Read, Grep, Bash`), which is what an unmodified agent file
 * carries.
 *
 * @internal
 */
function optionalToolRefs(
  value: unknown,
  field: string,
  source: string,
): string[] | undefined {
  if (typeof value === "string") {
    const refs = value
      .split(",")
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "");
    if (refs.length === 0) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": frontmatter field "${field}" is an empty string. Remove the key or list at least one tool.`,
      });
    }
    return refs;
  }
  return optionalStringArray(value, field, source);
}

/**
 * Whether a `disallowedTools` entry removes a granted reference. A bare
 * name denies every scoped grant of that tool, because a deny naming the
 * tool means the tool; a scoped deny removes only the exact grant.
 *
 * @internal
 */
function isDeniedBy(granted: string, denial: string): boolean {
  return granted === denial || toolNameOf(granted) === denial;
}

/**
 * Build the agent's tool selection from its frontmatter references.
 *
 * Two Claude-compatibility rules live here rather than in `tools()`,
 * because they are properties of a dropped-in file and not of the
 * selection grammar:
 *
 * - A reference to a Claude built-in this runtime does not provide is
 *   dropped with a warning. Resolution runs per dispatch, so the
 *   warning is emitted once per name per selection.
 * - `disallowedTools` removes references from the agent's own list.
 *   It cannot reach an inherited `defaultOptions.tools`, because a
 *   per-agent list replaces that default outright rather than
 *   narrowing it.
 *
 * @internal
 */
function toolSelection(
  refs: string[],
  disallowed: readonly string[],
  source: string,
): ToolSelection {
  const denied = new Set(disallowed);
  // ONLY a bare denial names the tool. Mapping every denial through
  // toolNameOf made a scoped `Bash(rm:*)` deny collapse to `Bash` and
  // silently remove every other Bash grant in the file, which is the
  // opposite of what isDeniedBy documents.
  const deniedNames = new Set(
    disallowed.filter((entry) => toolNameOf(entry) === entry.trim()),
  );
  // A deny that names something the agent never had is a typo, and the
  // tool it meant to remove stays granted. Same reason a deny with no
  // allow throws: a field whose whole purpose is removing capability
  // must not fail quietly.
  for (const ref of denied) {
    if (!refs.some((granted) => isDeniedBy(granted, ref))) {
      logger.warn(
        `Markdown file "${source}": "disallowedTools" names "${ref}", which is not in "tools", so the entry removes nothing. Check the spelling.`,
      );
    }
  }
  const warned = new Set<string>();
  return tools((catalog) => {
    const registered = new Set(catalog.fns.map((fn) => fn.name));
    const narrowable = new Set(
      catalog.fns.filter((fn) => fn.narrowable).map((fn) => fn.name),
    );
    const kept: string[] = [];
    for (const ref of refs) {
      // A scoped entry is the same tool as its bare name, so every check
      // here runs against the name rather than the whole reference.
      // Matching the reference verbatim is what made a real agent file
      // carrying `Bash(git status:*)` fail to load: the name never
      // reached the built-in check and fell through to unknown-tool.
      const name = toolNameOf(ref);
      if (denied.has(ref) || deniedNames.has(name)) continue;
      if (!registered.has(name) && CLAUDE_BUILTIN_TOOLS.has(name)) {
        if (!warned.has(name)) {
          warned.add(name);
          logger.warn(
            `Markdown file "${source}": tool "${name}" is a Claude Code built-in this runtime does not provide; skipping it for this agent.`,
          );
        }
        continue;
      }
      if (name === ref && narrowable.has(name) && !warned.has(`wide:${name}`)) {
        warned.add(`wide:${name}`);
        logger.warn(
          `Markdown file "${source}": tool "${name}" is granted without a specifier, so this agent may use it without limit. Narrow it by writing what it may do in parentheses, for example "${name}(git status:*)".`,
        );
      }
      kept.push(ref);
    }
    return kept;
  });
}

/**
 * Resolve the frontmatter `model` field to a full `provider:model`
 * reference.
 *
 * Claude's aliases map onto pinned ids; `inherit` maps to nothing at
 * all, which is exactly right here because an agent that sets no model
 * already picks up `agentPlugin({ defaultOptions: { model } })` at
 * dispatch.
 *
 * @internal
 */
function resolveModel(value: unknown, source: string): LlmModelId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter "model" must be a string of the form "provider:model" (e.g. "anthropic:claude-sonnet-4-6").`,
    });
  }
  if (value === "inherit") return undefined;
  // `Object.hasOwn` rather than a bare lookup: frontmatter is
  // file-controlled, and `model: constructor` would otherwise resolve
  // to a function off Object.prototype and be returned as a model id.
  const alias = Object.hasOwn(MODEL_ALIASES, value)
    ? MODEL_ALIASES[value]
    : undefined;
  if (alias !== undefined) return alias;
  if (!value.includes(":")) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter "model" ("${value}") is neither a known alias (${Object.keys(MODEL_ALIASES).sort().join(", ")}, inherit) nor a full "provider:model" reference.`,
    });
  }
  return value as LlmModelId;
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
      logger.warn(
        `Markdown file "${source}": frontmatter field "${key}" is not supported and was ignored. Supported fields: ${[...SUPPORTED_AGENT_KEYS].sort().join(", ")}.`,
      );
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
  const model = resolveModel(frontmatter["model"], source);
  const maxTurns = optionalPositiveInt(
    frontmatter["maxTurns"],
    "maxTurns",
    source,
  );
  const toolRefs = optionalToolRefs(frontmatter["tools"], "tools", source);
  const disallowed =
    optionalToolRefs(
      frontmatter["disallowedTools"],
      "disallowedTools",
      source,
    ) ?? [];
  if (disallowed.length > 0 && toolRefs === undefined) {
    // Fail loud rather than fail open. A per-agent list replaces the
    // context default outright rather than narrowing it, so a deny with
    // no allow cannot be honoured, and an agent that inherits the very
    // tools its file denies is the worst possible reading of the file.
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": "disallowedTools" is set but "tools" is not, and a deny list alone cannot be honoured: a per-agent tool list replaces the context default outright rather than narrowing it, so this agent would inherit the very tools it denies. List the tools this agent may use in "tools", or drop "disallowedTools". Honouring a deny list against inherited defaults was considered and declined: Routecraft's tool model is whitelist-only, and a deny list would silently grow every time the context's default toolset did. See routecraftjs/routecraft#583.`,
    });
  }
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
  if (model !== undefined) agent.model = model;
  if (maxTurns !== undefined) agent.maxTurns = maxTurns;
  if (toolRefs !== undefined)
    agent.tools = toolSelection(toolRefs, disallowed, source);
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
 * | `disallowedTools` | no   | removals from this agent's own `tools` |
 * | `principal`   | no       | `AgentRegisteredOptions.principal`     |
 * |               |          | (boolean only; renderer via override)  |
 * | `skills`      | no       | declaration consumed by `craft start`  |
 *
 * Body of the file becomes `system`. Other Claude subagent fields
 * (`permissionMode`, `mcpServers`, `hooks`, `memory`, `background`,
 * `effort`, `isolation`, `color`, `initialPrompt`, ...) are ignored
 * with one warning each and will land in follow-up stories as the
 * runtime gains the underlying features. Tolerating them is the point:
 * an unchanged `.claude/agents/` tree has to boot, and a key this
 * runtime has not implemented yet is not a mistake in the file.
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
