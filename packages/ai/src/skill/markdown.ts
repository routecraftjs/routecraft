import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { rcError } from "@routecraft/routecraft";

/**
 * Parsed markdown document: front matter as a plain object plus the
 * remaining body. Returned by {@link readMarkdownFile}.
 *
 * @internal
 */
export interface ParsedMarkdown {
  /** Path the document was read from. */
  path: string;
  /** Filename without extension. Matches the agent / skill `name` after validation. */
  filename: string;
  /** Parsed YAML front matter. Empty object when no front matter is present. */
  frontmatter: Record<string, unknown>;
  /** Trimmed body (everything after the front-matter block). */
  body: string;
}

/**
 * YAML parser shape we depend on. Lazy-loaded the first time a
 * markdown loader runs so the `yaml` package can be an optional peer
 * dependency: callers that never invoke `agents()` / `skills()` do
 * not need to install it, and it stays out of `@routecraft/ai`'s
 * static import graph (size-limit is enforced on the entry bundle).
 *
 * @internal
 */
type YamlParse = (text: string) => unknown;
let cachedParseYaml: YamlParse | undefined;

async function loadYamlParse(): Promise<YamlParse> {
  if (cachedParseYaml) return cachedParseYaml;
  try {
    const mod = (await import("yaml")) as { parse: YamlParse };
    cachedParseYaml = mod.parse;
    return cachedParseYaml;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("ERR_MODULE_NOT_FOUND") ||
        err.message.includes("Cannot find module") ||
        err.message.includes("Cannot find package")) &&
      err.message.includes("yaml")
    ) {
      throw new Error(
        `The markdown loaders (agents()/skills()) require the "yaml" package. Install it with: bun add yaml`,
      );
    }
    throw err;
  }
}

/**
 * Strip a `--- ... ---` YAML front-matter block from the start of the
 * file and return the parsed object plus the body. Files without a
 * leading `---` are treated as having no front matter (frontmatter is
 * `{}` and body is the full content).
 *
 * @internal
 */
async function splitFrontmatter(
  raw: string,
  path: string,
): Promise<ParsedMarkdown> {
  const filename = basename(path, extname(path));
  if (!raw.startsWith("---")) {
    return {
      path,
      filename,
      frontmatter: {},
      body: raw.trim(),
    };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${path}": opened a YAML front-matter block with "---" but never closed it. Add a closing "---" line before the body.`,
    });
  }
  const yamlText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  let parsed: unknown;
  try {
    if (yamlText) {
      const parseYaml = await loadYamlParse();
      parsed = parseYaml(yamlText);
    } else {
      parsed = {};
    }
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${path}": YAML front matter failed to parse. ${(err as Error).message}`,
    });
  }
  if (parsed !== null && typeof parsed !== "object") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${path}": YAML front matter must parse to an object (got ${typeof parsed}).`,
    });
  }
  return {
    path,
    filename,
    frontmatter: (parsed as Record<string, unknown> | null) ?? {},
    body,
  };
}

/**
 * Read a single markdown file from disk and split into front matter +
 * body. Resolves the path against `process.cwd()` so callers can pass
 * relative locations (`"./agents/researcher.md"`).
 *
 * @internal
 */
export async function readMarkdownFile(path: string): Promise<ParsedMarkdown> {
  const abs = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${path}" could not be read: ${(err as Error).message}`,
    });
  }
  return splitFrontmatter(raw, abs);
}

/**
 * Read every `.md` file directly under `dir` and return one
 * `ParsedMarkdown` entry per file. Subdirectories are not recursed
 * (Claude's subagent layout is flat; supporting nesting would
 * complicate id derivation).
 *
 * @internal
 */
export async function readMarkdownDir(dir: string): Promise<ParsedMarkdown[]> {
  const abs = resolve(process.cwd(), dir);
  let stats;
  try {
    stats = statSync(abs);
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown directory "${dir}" could not be opened: ${(err as Error).message}`,
    });
  }
  if (!stats.isDirectory()) {
    throw rcError("RC5003", undefined, {
      message: `Markdown directory "${dir}" is not a directory. Pass a path to a directory containing .md files.`,
    });
  }
  const out: ParsedMarkdown[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== ".md") continue;
    out.push(
      await splitFrontmatter(
        readFileSync(join(abs, entry.name), "utf-8"),
        join(abs, entry.name),
      ),
    );
  }
  // Sort so file order is deterministic regardless of filesystem
  // listing order. Useful for stable tests and reproducible builds.
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

/**
 * Validate that `value` is a non-empty string and return it; otherwise
 * throw RC5003 quoting the field name and source path.
 *
 * @internal
 */
export function requireString(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter field "${field}" must be a non-empty string.`,
    });
  }
  return value;
}

/**
 * Validate that `value` is an array of non-empty strings (or
 * undefined) and return it; otherwise throw RC5003.
 *
 * @internal
 */
export function optionalStringArray(
  value: unknown,
  field: string,
  source: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter field "${field}" must be an array of strings.`,
    });
  }
  for (const v of value) {
    if (typeof v !== "string" || v.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${source}": frontmatter field "${field}" must contain only non-empty strings.`,
      });
    }
  }
  return value as string[];
}

/**
 * Validate that `value` is a finite positive integer (or undefined)
 * and return it; otherwise throw RC5003.
 *
 * @internal
 */
export function optionalPositiveInt(
  value: unknown,
  field: string,
  source: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter field "${field}" must be a positive integer.`,
    });
  }
  return value;
}
