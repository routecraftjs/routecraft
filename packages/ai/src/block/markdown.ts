import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename, extname, sep } from "node:path";
import { loadOptionalPeer, rcError } from "@routecraft/routecraft";

/**
 * Parsed markdown document: front matter as a plain object plus the
 * remaining body. Returned by {@link readMarkdownFile}.
 *
 * @internal
 */
export interface ParsedMarkdown {
  /** Path the document was read from. */
  path: string;
  /** Filename without extension. Matches the agent or block `name` after validation. */
  filename: string;
  /** Parsed YAML front matter. Empty object when no front matter is present. */
  frontmatter: Record<string, unknown>;
  /** Trimmed body (everything after the front-matter block). */
  body: string;
  /**
   * Absolute path of the bundle directory when the document was
   * discovered through the `sentinelFilename` form (`<name>/SKILL.md`,
   * `<name>/AGENT.md`). Absent for flat `.md` files.
   *
   * Presence is the signal that this document is a bundle, so do not
   * repurpose it as a general base directory: a caller that set it for
   * flat documents too would silently subject every one of them to
   * whatever rule the loader applies to bundles. Whether that rule is
   * directory-is-identity is per loader; `agents()` applies it,
   * `skills()` currently keys identity off `filename` for both layouts.
   */
  bundleDirectory?: string;
}

/**
 * YAML parser shape we depend on. Lazy-loaded the first time a
 * markdown loader runs so the `yaml` package can be an optional peer
 * dependency: callers that never invoke `agents()` or `skills()`
 * do not need to install it, and it stays out of `@routecraft/ai`'s
 * static import graph (size-limit is enforced on the entry bundle).
 *
 * @internal
 */
type YamlParse = (text: string) => unknown;
let cachedParseYaml: YamlParse | undefined;

async function loadYamlParse(): Promise<YamlParse> {
  if (cachedParseYaml) return cachedParseYaml;
  const mod = (await loadOptionalPeer(() => import("yaml"), {
    consumer: "Markdown loader (agents() / skills())",
    packageName: "yaml",
  })) as { parse: YamlParse };
  cachedParseYaml = mod.parse;
  return cachedParseYaml;
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
  if (yamlText) {
    // Load OUTSIDE the parse-error wrap: a missing `yaml` package must
    // surface as RC5017 with an install hint, not as a misleading
    // "front matter failed to parse" error pointing at the user's file.
    const parseYaml = await loadYamlParse();
    try {
      parsed = parseYaml(yamlText);
    } catch (err) {
      throw rcError("RC5003", undefined, {
        message: `Markdown file "${path}": YAML front matter failed to parse. ${(err as Error).message}`,
      });
    }
  } else {
    parsed = {};
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
 * Options controlling how {@link readMarkdownDir} discovers entries.
 *
 * @internal
 */
export interface ReadMarkdownDirOptions {
  /**
   * When set, subdirectories of `dir` are also inspected. If a
   * subdirectory contains a file with this exact name (e.g.
   * `"SKILL.md"`), it is yielded as a single `ParsedMarkdown` whose
   * `filename` is the **subdirectory name**, not the sentinel stem,
   * and whose `bundleDirectory` is the subdirectory path. This matches the
   * Claude Code skill convention (`<name>/SKILL.md`), where the
   * directory name is the identity and the folder can also bundle
   * supporting assets. A sentinel bundle is never descended into.
   */
  sentinelFilename?: string;
  /**
   * Descend into subdirectories that are neither a sentinel bundle nor
   * reserved. Off by default, so a caller that only wants one level
   * keeps it. With it on, a `.md` file at any depth is yielded as a
   * flat document, matching Claude Code's recursive `agents/` scan
   * where the subdirectory path is grouping and carries no identity.
   */
  recursive?: boolean;
  /**
   * Directory names that are never inspected, at any depth. Used for
   * folders the walk must leave to another loader: `skills` under
   * `agents/` belongs to the enclosing agent bundle, so treating its
   * markdown as agents would fail the boot on the first file.
   *
   * Checked before the sentinel, so a directory whose name is reserved
   * is never treated as a bundle either.
   */
  reservedDirectories?: readonly string[];
}

/**
 * Directory names skipped by every walk. A dependency tree or an
 * editor's dot-folder under a content directory is never authored
 * content, and recursing into `node_modules` would walk a package
 * tree looking for markdown.
 *
 * @internal
 */
function isSkippedDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/**
 * Walk one directory level, appending discovered documents to `out`.
 * Recurses only when `options.recursive` is set and the subdirectory is
 * neither a sentinel bundle nor reserved.
 *
 * @internal
 */
async function collectMarkdown(
  abs: string,
  options: ReadMarkdownDirOptions,
  out: ParsedMarkdown[],
): Promise<void> {
  const reserved = options.reservedDirectories ?? [];
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown directory "${abs}" could not be read: ${(err as Error).message}`,
    });
  }
  for (const entry of entries) {
    const child = join(abs, entry.name);
    if (entry.isFile() || (entry.isSymbolicLink() && isFilePath(child))) {
      if (extname(entry.name).toLowerCase() !== ".md") continue;
      out.push(await splitFrontmatter(readMarkdownContent(child), child));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (isSkippedDirectory(entry.name)) continue;
    if (reserved.includes(entry.name)) continue;
    if (options.sentinelFilename) {
      const sentinelPath = join(child, options.sentinelFilename);
      if (isFilePath(sentinelPath)) {
        const parsed = await splitFrontmatter(
          readMarkdownContent(sentinelPath),
          sentinelPath,
        );
        // The bundle directory is the identity, not the sentinel stem.
        parsed.filename = entry.name;
        parsed.bundleDirectory = child;
        out.push(parsed);
        continue;
      }
    }
    if (options.recursive) await collectMarkdown(child, options, out);
  }
}

/**
 * True when `path` resolves to a file, following symlinks. Returns
 * false rather than throwing for a path that is missing or not a
 * directory, which are both ordinary answers during a walk.
 *
 * @internal
 */
function isFilePath(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    // Still reachable for EACCES and friends, which `throwIfNoEntry`
    // does not cover. An unreadable candidate is simply not a file we
    // can load.
    return false;
  }
}

/**
 * Read a markdown file, reporting a failure as RC5003 naming the path.
 * The walk lists a directory and then reads what it listed, so a file
 * removed or made unreadable in between surfaces here.
 *
 * @internal
 */
function readMarkdownContent(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${path}" could not be read: ${(err as Error).message}`,
    });
  }
}

/**
 * Read markdown documents from `dir` and return one `ParsedMarkdown`
 * entry per discovered file.
 *
 * - Flat `.md` files directly under `dir` are always loaded.
 * - When `sentinelFilename` is set, subdirectories containing that
 *   exact file are loaded as one document keyed by the **subdirectory
 *   name** and are not descended into.
 * - When `recursive` is set, every other subdirectory is walked, so a
 *   `.md` file at any depth loads as a flat document.
 *
 * `node_modules`, dot-directories, and any name in
 * `reservedDirectories` are skipped at every level. Subdirectories
 * without the configured sentinel are silently skipped when the walk
 * is not recursive, so a folder mixed in with real skills does not
 * produce noise.
 *
 * A symlink to a file is followed, so a tree assembled by linking
 * shared definitions loads. A symlink to a directory is not, which
 * makes the walk loop-free by construction: a cycle needs a directory
 * link.
 *
 * @internal
 */
export async function readMarkdownDir(
  dir: string,
  options: ReadMarkdownDirOptions = {},
): Promise<ParsedMarkdown[]> {
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
  await collectMarkdown(abs, options, out);
  // Sort on a separator-normalized key so order is deterministic
  // regardless of filesystem listing order and identical across
  // platforms, matching `scanDirectory`: a raw sort diverges on
  // Windows, where the backslash separator (0x5C) sorts after
  // characters that `/` (0x2F) sorts before. Compared with `<` rather
  // than `localeCompare`, which is locale dependent.
  const sortKey = (doc: ParsedMarkdown): string =>
    sep === "/" ? doc.path : doc.path.split(sep).join("/");
  out.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

/**
 * Read a markdown source that may be a single file or a directory.
 *
 * Classification comes from the filesystem, not from the name: a
 * directory called `agents.md` is still a directory and gets walked,
 * where an extension rule would try to read it and fail with EISDIR.
 * The extension is then only used to reject a file that is not
 * markdown, so the caller gets a sentence rather than a parse error.
 *
 * @internal
 */
export async function readMarkdownSource(
  path: string,
  options: ReadMarkdownDirOptions = {},
): Promise<ParsedMarkdown[]> {
  const abs = resolve(process.cwd(), path);
  let stats;
  try {
    stats = statSync(abs);
  } catch (err) {
    throw rcError("RC5003", undefined, {
      message: `Markdown source "${path}" could not be opened: ${(err as Error).message}`,
    });
  }
  if (stats.isDirectory()) return readMarkdownDir(path, options);
  if (extname(abs).toLowerCase() !== ".md") {
    throw rcError("RC5003", undefined, {
      message: `Markdown source "${path}" is a file but not a ".md" file. Pass a markdown file, or a directory containing them.`,
    });
  }
  return [await readMarkdownFile(path)];
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
 * Validate that `value` is a boolean (or undefined) and return it;
 * otherwise throw RC5003. Use for frontmatter flags that map to a
 * boolean option; the function-form variant of an option (a closure)
 * cannot be expressed in YAML and must be set in code instead.
 *
 * @internal
 */
export function optionalBoolean(
  value: unknown,
  field: string,
  source: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw rcError("RC5003", undefined, {
      message: `Markdown file "${source}": frontmatter field "${field}" must be a boolean (true or false).`,
    });
  }
  return value;
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
