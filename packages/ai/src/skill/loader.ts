import { rcError } from "@routecraft/routecraft";
import {
  readMarkdownDir,
  readMarkdownFile,
  requireString,
} from "./markdown.ts";
import type { Skill } from "./types.ts";

/**
 * Reject unknown frontmatter fields up front so a misspelt key never
 * silently disappears. The frontmatter shape mirrors a deliberately
 * narrow subset of Claude's subagent skills schema (`name`,
 * `description`); future fields will land incrementally.
 */
const SUPPORTED_SKILL_KEYS = new Set(["name", "description"]);

/**
 * Per-skill override applied on top of the markdown frontmatter.
 *
 * @experimental
 */
export interface SkillOverride {
  description?: string;
  content?: string;
}

/**
 * Convert a parsed markdown file into a `Skill`. Validates that
 * frontmatter `name` matches the filename so the registry id is
 * unambiguous, and that body is non-empty so the agent never injects
 * a hollow skill into its system prompt.
 *
 * @internal
 */
function toSkill(
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
  source: string,
): Skill {
  for (const key of Object.keys(frontmatter)) {
    if (!SUPPORTED_SKILL_KEYS.has(key)) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": unsupported frontmatter field "${key}". Skills currently support only "name" and "description"; further fields land in follow-up stories.`,
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
      message: `Markdown file "${source}": skill body is empty. The body becomes the injected skill content; an empty body would not change the agent's behaviour.`,
    });
  }
  return { name, description, content: body };
}

/**
 * Load skills from a markdown file or directory.
 *
 * - If `path` points to a directory, every `.md` file directly under it
 *   becomes one skill. The filename (without `.md`) is the skill name
 *   and must match the frontmatter `name`.
 * - If `path` points to a single `.md` file, the file becomes one
 *   skill keyed by its filename.
 *
 * Frontmatter currently supports only `name` (required) and
 * `description` (required). Body of the file becomes
 * `Skill.content` and is concatenated into the system prompt of any
 * agent that lists the skill name in its `skills` array.
 *
 * Pass `overrides` keyed by skill name to replace `description` or
 * `content` per skill without editing the markdown source.
 *
 * Returns a `Record<name, Skill>` ready to spread into
 * `agentPlugin({ skills: skills("./skills") })`.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agentPlugin({
 *   skills: skills("./skills"),
 *   agents: agents("./agents"),
 * });
 * ```
 */
export function skills(
  path: string,
  overrides: Record<string, SkillOverride> = {},
): Record<string, Skill> {
  const out: Record<string, Skill> = {};
  const docs = path.endsWith(".md")
    ? [readMarkdownFile(path)]
    : readMarkdownDir(path);
  for (const doc of docs) {
    const skill = toSkill(doc.filename, doc.frontmatter, doc.body, doc.path);
    const override = overrides[skill.name];
    out[skill.name] = override ? { ...skill, ...override } : skill;
  }
  // Surface override entries that didn't match any loaded skill so a
  // typo in the override key doesn't silently no-op.
  for (const name of Object.keys(overrides)) {
    if (!(name in out)) {
      throw rcError("RC5003", undefined, {
        message: `skills("${path}"): override for "${name}" but no skill with that name was loaded from disk.`,
      });
    }
  }
  return out;
}
