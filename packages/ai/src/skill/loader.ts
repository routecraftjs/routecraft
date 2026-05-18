import { rcError } from "@routecraft/routecraft";
import {
  readMarkdownDir,
  readMarkdownFile,
  requireString,
} from "./markdown.ts";
import type { Skill } from "./types.ts";

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
 * frontmatter `name`, when present, matches the directory or
 * filename so the registry id is unambiguous, and that body is
 * non-empty so the agent never injects a hollow skill into its
 * system prompt.
 *
 * Unknown top-level frontmatter keys are silently accepted: Claude
 * Code's full skill frontmatter schema (`allowed-tools`,
 * `argument-hint`, `disable-model-invocation`, `when_to_use`, etc.)
 * is much wider than routecraft consumes, and tooling commonly
 * layers further metadata on top. Keys other than `name` and
 * `description` are ignored by the runtime; only those two are
 * validated.
 *
 * @internal
 */
function toSkill(
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
  source: string,
): Skill {
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
 * Two directory layouts are supported and may coexist in the same
 * folder, matching the [Claude Code skill convention](https://code.claude.com/docs/en/skills):
 *
 * - **Flat:** a `.md` file directly under the directory. The filename
 *   (without `.md`) is the skill name and must match frontmatter
 *   `name`.
 * - **Nested:** a `<name>/SKILL.md` file inside a subdirectory. The
 *   subdirectory name is the skill name and must match frontmatter
 *   `name`. The folder can also bundle supporting assets (scripts,
 *   templates, examples); the loader only consumes `SKILL.md`.
 *
 * Subdirectories without a `SKILL.md` sentinel are silently skipped.
 *
 * If `path` points to a single `.md` file, the file becomes one
 * skill keyed by its filename.
 *
 * Frontmatter requires `name` and `description`. Any other keys
 * (including Claude Code fields like `allowed-tools`, `when_to_use`,
 * `argument-hint`, `disable-model-invocation`, or arbitrary metadata
 * blocks added by other tooling) are silently accepted and ignored.
 *
 * Body of the file becomes `Skill.content` and is concatenated into
 * the system prompt of any agent that lists the skill name in its
 * `skills` array.
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
export async function skills(
  path: string,
  overrides: Record<string, SkillOverride> = {},
): Promise<Record<string, Skill>> {
  const out: Record<string, Skill> = {};
  const sources = new Map<string, string>();
  const docs = path.endsWith(".md")
    ? [await readMarkdownFile(path)]
    : await readMarkdownDir(path, { sentinelFilename: "SKILL.md" });
  for (const doc of docs) {
    const skill = toSkill(doc.filename, doc.frontmatter, doc.body, doc.path);
    // Flat `foo.md` and nested `foo/SKILL.md` can both resolve to the
    // same skill name. Reject explicitly so the conflict is visible
    // at load time instead of silently last-write-wins.
    const previousSource = sources.get(skill.name);
    if (previousSource) {
      throw rcError("RC5003", undefined, {
        message: `skills("${path}"): duplicate skill name "${skill.name}" loaded from both "${previousSource}" and "${doc.path}". Each skill name must be unique within a directory; rename or remove one source.`,
      });
    }
    sources.set(skill.name, doc.path);
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
