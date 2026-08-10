import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  logger,
  rcError,
  registerProjectDiscoverer,
  type CraftConfig,
} from "@routecraft/routecraft";
import { skills } from "./block/builders.ts";
import { loadAgentFiles, type LoadedAgentFile } from "./agent/loader.ts";
import type { Blocks } from "./block/types.ts";
import type { AgentRegisteredOptions } from "./agent/types.ts";

/**
 * Folder holding skills, both as the project's house folder and as the
 * folder scoped to a single agent bundle.
 *
 * @internal
 */
const SKILLS_FOLDER = "skills";

/**
 * Folder holding agent definitions.
 *
 * @internal
 */
const AGENTS_FOLDER = "agents";

/**
 * Prefix marking a skills ref that resolves against installed
 * packages rather than the filesystem beside the agent file.
 *
 * @internal
 */
const PACKAGE_REF_PREFIX = "npm:";

/**
 * Name of the project configuration file, used in log lines that
 * report which side of the precedence rule a field came from.
 *
 * @internal
 */
const CONFIG_FILE = "craft.config.ts";

/**
 * Run order for the two discoverers this package registers. `agents`
 * runs second so it can read the house skills the `skills` discoverer
 * contributed: a per-agent block replaces a same-named default rather
 * than merging into it, so an agent with its own skills has to compose
 * the house set explicitly or it would silently lose it.
 *
 * @internal
 */
const SKILLS_ORDER = 10;
const AGENTS_ORDER = 20;

/**
 * One resolved contribution to an agent's skill set, kept with the
 * place it came from so a collision can name both sides.
 *
 * @internal
 */
interface SkillSource {
  label: string;
  blocks: Blocks;
}

/**
 * A composed skill group plus the sources that fed it, in the order
 * they were applied. The labels are what the startup log reports as
 * the provenance of `blocks.skills`.
 *
 * @internal
 */
interface ComposedSkills {
  blocks: Blocks;
  sources: string[];
}

/**
 * Render a path for a log line: relative to the project's content root
 * when it sits inside it, absolute otherwise.
 *
 * @internal
 */
function displayPath(contentRoot: string, path: string): string {
  const rel = relative(contentRoot, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

/**
 * Read the `skills` group already present on the agent defaults, if it
 * is a group we can compose with. A single block body is a legitimate
 * value that simply cannot be merged into, so it is left alone: the
 * agent still inherits it through the normal default path when it
 * declares no skills of its own.
 *
 * @internal
 */
function houseSkillGroup(config: Readonly<CraftConfig>): Blocks | undefined {
  const existing = config.agent?.defaultOptions?.blocks?.[SKILLS_FOLDER];
  if (existing === undefined) return undefined;
  if (typeof (existing as { mode?: unknown }).mode === "string")
    return undefined;
  return existing as Blocks;
}

/**
 * Split a package ref into the package name and the subpath after it.
 * Scoped names take two segments, everything else one.
 *
 * @internal
 */
function splitPackageRef(ref: string): { name: string; subpath: string } {
  const segments = ref.split("/").filter((s) => s !== "");
  const nameSegments = ref.startsWith("@") ? 2 : 1;
  return {
    name: segments.slice(0, nameSegments).join("/"),
    subpath: segments.slice(nameSegments).join("/"),
  };
}

/**
 * Locate the installed root directory of `name`, resolving from
 * `fromFile` so the project's own `node_modules` is what gets searched
 * rather than this package's.
 *
 * Tries the `./package.json` export first because it lands on the root
 * directly. Packages with a restrictive `exports` map do not expose it,
 * so the fallback resolves the package entry point and walks up to the
 * manifest that names the package.
 *
 * @internal
 */
function resolvePackageRoot(name: string, fromFile: string): string {
  const require = createRequire(pathToFileURL(fromFile));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Fall through to the entry-point walk.
  }
  let dir: string;
  try {
    dir = dirname(require.resolve(name));
  } catch (cause) {
    throw rcError("AI1004", cause, {
      message: `Skills package "${name}" is not installed (resolved from "${fromFile}"). Add it to the project's dependencies: bun add ${name}`,
    });
  }
  for (let up = dir; ; up = dirname(up)) {
    const manifest = join(up, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as {
          name?: unknown;
        };
        if (parsed.name === name) return up;
      } catch {
        // An unreadable manifest is not the one we are looking for.
      }
    }
    if (dirname(up) === up) break;
  }
  throw rcError("AI1004", undefined, {
    message: `Skills package "${name}" resolved to "${dir}" but no package.json naming it was found above that path. The package layout is not one this loader can read; point the ref at a local folder instead.`,
  });
}

/**
 * Resolve a skills ref to a directory on disk.
 *
 * A local ref is relative to the agent file that declared it, which
 * keeps a bundle's `./skills` meaning the same wherever the bundle
 * sits in the tree. A `npm:` ref resolves against installed packages,
 * with no network access at boot and no trust surface beyond the
 * dependencies already in `package.json`.
 *
 * The package layout rule, in order:
 *
 * 1. `npm:<pkg>/<subpath>` looks for `<root>/<subpath>`, then
 *    `<root>/skills/<subpath>`.
 * 2. `npm:<pkg>` looks for `<root>/skills`, then `<root>` itself.
 *
 * Plain subpath first, because that is what a package of skill trees
 * (one folder per collection) reads like at the call site, and the
 * `skills/` root second so a package that keeps its skills in one
 * conventional place does not have to spell it out. Export maps are
 * deliberately not consulted: they resolve to files, and a skill
 * source is a directory.
 *
 * @internal
 */
function resolveSkillsRef(ref: string, agentFile: string): string {
  const candidates: string[] = [];
  if (ref.startsWith(PACKAGE_REF_PREFIX)) {
    const spec = ref.slice(PACKAGE_REF_PREFIX.length).trim();
    if (spec === "") {
      throw rcError("AI1004", undefined, {
        message: `Skills ref "${ref}" declared in "${agentFile}" names no package. Use "npm:<package>" or "npm:<package>/<subpath>".`,
      });
    }
    const { name, subpath } = splitPackageRef(spec);
    const root = resolvePackageRoot(name, agentFile);
    if (subpath) {
      const within = resolve(root, subpath);
      const rel = relative(root, within);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw rcError("AI1004", undefined, {
          message: `Skills ref "${ref}" declared in "${agentFile}" points outside the package root ("${root}"). Remove the "../" segments.`,
        });
      }
      candidates.push(within, join(root, SKILLS_FOLDER, subpath));
    } else {
      candidates.push(join(root, SKILLS_FOLDER), root);
    }
  } else {
    candidates.push(resolve(dirname(agentFile), ref));
  }
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }
  throw rcError("AI1004", undefined, {
    message: `Skills ref "${ref}" declared in "${agentFile}" did not resolve to a directory. Looked in: ${candidates.join(", ")}.`,
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Compose the skill sources that apply to one agent, most specific
 * last: house folder, then the frontmatter refs in declared order,
 * then the bundle's own `skills/` folder.
 *
 * Returns `undefined` when the agent declares nothing of its own, so
 * the agent inherits `defaultOptions.blocks.skills` untouched. That
 * matters for a dropped-in Claude Code agent file, which carries no
 * `skills:` key at all: the absence means "the house set", never "no
 * skills".
 *
 * @internal
 */
async function composeAgentSkills(
  file: LoadedAgentFile,
  house: SkillSource | undefined,
  contentRoot: string,
): Promise<ComposedSkills | undefined> {
  const own: SkillSource[] = [];
  for (const ref of file.skills ?? []) {
    const directory = resolveSkillsRef(ref, file.source);
    own.push({
      // A package ref reads better as authored than as the path it
      // resolved to inside node_modules; a local one reads better as
      // the folder it actually landed on.
      label: ref.startsWith(PACKAGE_REF_PREFIX)
        ? ref
        : displayPath(contentRoot, directory),
      blocks: await skills({ source: directory }),
    });
  }
  if (file.bundleDirectory !== undefined) {
    const bundleSkills = join(file.bundleDirectory, SKILLS_FOLDER);
    if (isDirectory(bundleSkills)) {
      own.push({
        label: displayPath(contentRoot, bundleSkills),
        blocks: await skills({ source: bundleSkills }),
      });
    }
  }
  if (own.length === 0) return undefined;

  const sources = house ? [house, ...own] : own;
  const out: Blocks = {};
  const origin = new Map<string, string>();
  for (const source of sources) {
    for (const [name, block] of Object.entries(source.blocks)) {
      const prior = origin.get(name);
      if (prior !== undefined) {
        logger.info(
          `Agent "${file.name}": skill "${name}" from ${source.label} shadows the one from ${prior}.`,
        );
      }
      origin.set(name, source.label);
      out[name] = block;
    }
  }
  return { blocks: out, sources: sources.map((source) => source.label) };
}

/**
 * House skills: `skills/` at the project's content root becomes the
 * default skill group every agent inherits, grouped under `skills` so
 * leaves resolve as `skills__<name>` and an agent can drop the whole
 * set with `blocks: { skills: false }`.
 */
registerProjectDiscoverer(
  SKILLS_FOLDER,
  async (directory, config) => {
    if (config.agent?.defaultOptions?.blocks?.[SKILLS_FOLDER] !== undefined) {
      logger.info(
        `Skills: "agent.defaultOptions.blocks.skills" is set in craft.config.ts; "${directory}" not loaded.`,
      );
      return {};
    }
    const loaded = await skills({ source: directory });
    logger.info(
      `Skills: loaded ${Object.keys(loaded).length} house skill(s) from "${directory}".`,
    );
    return {
      agent: { defaultOptions: { blocks: { [SKILLS_FOLDER]: loaded } } },
    };
  },
  { order: SKILLS_ORDER },
);

/**
 * Agents: every definition under `agents/` is registered, and each
 * agent's skills are composed from the house folder, its frontmatter
 * `skills:` refs, and its own bundle folder.
 *
 * Code wins per field rather than wholesale. An agent the project
 * already declared in `craft.config.ts` keeps every field it set; the
 * only thing discovery contributes is the resolved skill set, and only
 * when the config did not set one. That is what lets a project keep an
 * `agents("./agents", { zoe: { tools } })` call for the fields YAML
 * cannot carry (guards are functions) while zoe's skills live in her
 * frontmatter.
 */
registerProjectDiscoverer(
  AGENTS_FOLDER,
  async (directory, config) => {
    const declared = config.agent?.agents ?? {};
    const contentRoot = dirname(directory);
    const houseBlocks = houseSkillGroup(config);
    const houseDirectory = join(contentRoot, SKILLS_FOLDER);
    const house: SkillSource | undefined = houseBlocks
      ? {
          label: isDirectory(houseDirectory)
            ? displayPath(contentRoot, houseDirectory)
            : "agent.defaultOptions.blocks.skills",
          blocks: houseBlocks,
        }
      : undefined;

    const discovered: Record<string, AgentRegisteredOptions> = {};
    for (const file of await loadAgentFiles(directory)) {
      const declaredAgent = Object.prototype.hasOwnProperty.call(
        declared,
        file.name,
      )
        ? declared[file.name]
        : undefined;
      const composed = await composeAgentSkills(file, house, contentRoot);
      const from = displayPath(contentRoot, file.source);
      const skillsProvenance =
        composed === undefined
          ? undefined
          : `blocks.skills from ${[from, ...composed.sources].join(" + ")}`;

      if (declaredAgent !== undefined) {
        const configFields = Object.keys(declaredAgent).sort().join(", ");
        if (composed === undefined) {
          logger.info(
            `Agent "${file.name}": ${configFields} from ${CONFIG_FILE}; ${from} contributes nothing further.`,
          );
          continue;
        }
        if (declaredAgent.blocks?.[SKILLS_FOLDER] !== undefined) {
          logger.info(
            `Agent "${file.name}": ${configFields} from ${CONFIG_FILE}, including blocks.skills; the "skills:" refs in ${from} are not loaded.`,
          );
          continue;
        }
        discovered[file.name] = {
          ...declaredAgent,
          blocks: {
            ...declaredAgent.blocks,
            [SKILLS_FOLDER]: composed.blocks,
          },
        };
        logger.info(
          `Agent "${file.name}": ${configFields} from ${CONFIG_FILE}, ${skillsProvenance}.`,
        );
        continue;
      }

      discovered[file.name] =
        composed === undefined
          ? file.agent
          : {
              ...file.agent,
              blocks: {
                ...file.agent.blocks,
                [SKILLS_FOLDER]: composed.blocks,
              },
            };
      logger.info(
        skillsProvenance === undefined
          ? `Agent "${file.name}": loaded from ${from}.`
          : `Agent "${file.name}": loaded from ${from}, ${skillsProvenance}.`,
      );
    }
    return { agent: { agents: discovered } };
  },
  { order: AGENTS_ORDER },
);
