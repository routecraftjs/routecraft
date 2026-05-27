import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  rcError,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import {
  readMarkdownDir,
  readMarkdownFile,
  requireString,
} from "./markdown.ts";
import type {
  BlockBody,
  BlockClient,
  BlockLifetime,
  BlockMode,
  Blocks,
} from "./types.ts";

/**
 * Options for {@link skills}. Loads markdown skills from disk and
 * returns one {@link BlockBody} per skill, keyed by skill name, so
 * the agent picks them up via its `blocks: { ... }` record.
 */
export interface SkillsOptions {
  /**
   * Path to a single `.md` file or a directory containing skill
   * markdown files. Directories support the Claude Code convention:
   * flat `.md` files and nested `<name>/SKILL.md` folders may
   * coexist.
   */
  source: string;
  /**
   * How skills are surfaced to the model. Defaults to `"progressive"`
   * so the model sees each skill's name + description in the system
   * prompt and only loads the body via a tool call when relevant
   * (matches Claude Code's default progressive-disclosure behaviour).
   * Pass `"inject"` to concatenate every skill's full body into the
   * system prompt on every dispatch.
   */
  mode?: BlockMode;
  /**
   * Per-block lifetime applied to every loaded skill. Defaults to
   * `"dispatch"`. Pass `"context"` to read each skill file once per
   * `CraftContext` and reuse the parsed content across dispatches.
   */
  lifetime?: BlockLifetime;
}

/**
 * Load markdown skills from disk and return them as a {@link Blocks}
 * record ready to spread into an agent's `blocks: { ... }` map.
 *
 * Two layouts are supported and may coexist in the same folder:
 *
 * - **Flat**: `<dir>/<name>.md` -- filename (without `.md`) is the
 *   skill name and must match the frontmatter `name`.
 * - **Nested**: `<dir>/<name>/SKILL.md` -- the subdirectory name is
 *   the skill name and must match the frontmatter `name`. The folder
 *   can also bundle supporting assets; only `SKILL.md` is consumed.
 *
 * The `description` frontmatter becomes the block's description (used
 * verbatim when `mode: "progressive"` so the model can decide whether
 * to load); the markdown body becomes the block's static `value`.
 *
 * @example
 * ```ts
 * agent({
 *   model: "anthropic:claude-sonnet-4-6",
 *   system: "You are an analyst.",
 *   blocks: {
 *     ...(await skills({ source: "./skills" })),
 *   },
 * });
 * ```
 */
export async function skills(options: SkillsOptions): Promise<Blocks> {
  if (!options || typeof options !== "object") {
    throw rcError("RC5027", undefined, {
      message: `skills: options must be an object with at least { source }.`,
    });
  }
  const { source, mode = "progressive", lifetime } = options;
  if (typeof source !== "string" || source.trim() === "") {
    throw rcError("RC5027", undefined, {
      message: `skills: "source" must be a non-empty path to a markdown file or directory.`,
    });
  }
  if (mode !== "inject" && mode !== "progressive") {
    throw rcError("RC5027", undefined, {
      message: `skills: "mode" must be "inject" or "progressive" (got ${JSON.stringify(mode)}).`,
    });
  }
  if (
    lifetime !== undefined &&
    lifetime !== "dispatch" &&
    lifetime !== "context"
  ) {
    throw rcError("RC5027", undefined, {
      message: `skills: "lifetime" must be "dispatch" or "context" when present (got ${JSON.stringify(lifetime)}).`,
    });
  }
  const docs = source.endsWith(".md")
    ? [await readMarkdownFile(source)]
    : await readMarkdownDir(source, { sentinelFilename: "SKILL.md" });
  const sources = new Map<string, string>();
  const out: Record<string, BlockBody> = {};
  for (const doc of docs) {
    const name = requireString(doc.frontmatter["name"], "name", doc.path);
    if (name !== doc.filename) {
      throw rcError("RC5027", undefined, {
        message: `skills: markdown file "${doc.path}": frontmatter "name" ("${name}") must match the filename ("${doc.filename}"). Rename one or the other.`,
      });
    }
    const description = requireString(
      doc.frontmatter["description"],
      "description",
      doc.path,
    );
    if (doc.body.trim() === "") {
      throw rcError("RC5027", undefined, {
        message: `skills: markdown file "${doc.path}": skill body is empty. The body becomes the block's content; an empty body would not change the agent's behaviour.`,
      });
    }
    const prior = sources.get(name);
    if (prior) {
      throw rcError("RC5026", undefined, {
        message: `skills("${source}"): duplicate skill name "${name}" loaded from both "${prior}" and "${doc.path}". Each skill name must be unique within a source; rename or remove one.`,
      });
    }
    sources.set(name, doc.path);
    const body: BlockBody = { description, mode, value: doc.body };
    if (lifetime !== undefined) body.lifetime = lifetime;
    out[name] = body;
  }
  return out;
}

/**
 * Return a function-form resolver that reads a UTF-8 text file at
 * dispatch (or context-init) time. Useful when a block's content
 * lives on disk and may be edited without restarting the process.
 *
 * Resolves the path against `process.cwd()` so relative paths
 * (`"./prompts/identity.md"`) work the same way the markdown loaders
 * do.
 *
 * @example
 * ```ts
 * agent({
 *   model: "anthropic:claude-sonnet-4-6",
 *   system: "You are Zoe.",
 *   blocks: {
 *     identity: {
 *       mode: "inject",
 *       lifetime: "context",
 *       value: fromFile("./prompts/identity.md"),
 *     },
 *   },
 * });
 * ```
 */
export function fromFile(
  path: string,
): (
  exchange: Exchange<unknown>,
  context: CraftContext,
  events: readonly unknown[],
  client: BlockClient,
) => Promise<string> {
  if (typeof path !== "string" || path.trim() === "") {
    throw rcError("RC5027", undefined, {
      message: `fromFile: "path" must be a non-empty string.`,
    });
  }
  return async () => {
    const abs = resolvePath(process.cwd(), path);
    try {
      return readFileSync(abs, "utf-8");
    } catch (cause) {
      throw rcError("RC5025", cause, {
        message: `fromFile("${path}"): could not read file: ${(cause as Error)?.message ?? String(cause)}`,
      });
    }
  };
}
