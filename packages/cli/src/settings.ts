/**
 * The CLI's personal settings file.
 *
 * This is the person's file, not the app's. `craft.config.ts` decides what
 * exists in an instance and what it exposes; this decides how one operator
 * likes to talk to it: which address, which credential, which output
 * format. The distinction matters because the two have different owners and
 * different lifetimes, and a setting that drifts across it ends up either
 * committed with a token in it or lost on another machine.
 *
 * Two locations, both YAML, both optional:
 *
 * - project-local: `.routecraft/settings.yaml` under the working directory
 * - global: `.routecraft/settings.yaml` under the user's home
 *
 * `.yml` is accepted as an alternate spelling in either location; a
 * location carrying both spellings is refused with both paths named.
 *
 * Project-local wins over global, an environment variable wins over both,
 * and a flag wins over everything. `.routecraft/` is already gitignored,
 * which is what keeps a pasted token out of a commit; the scaffolder half
 * of that lives in #588.
 *
 * A profile is a named set of those values, and selecting one selects the
 * instance, the credential, the output format, the agent and the
 * environment together. Inside one file a profile beats a bare key,
 * because it is the more specific thing the person asked for; between
 * files the project still beats the home directory, because a profile
 * somebody keeps in their home directory must never be able to redirect
 * an instance a repository pinned.
 *
 * Every resolved value remembers where it came from, because the one
 * question a failed connection has to answer is "which address did it
 * actually use, and who told it that".
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

import { messageOf } from "./util.js";

/** Where a resolved value came from, in precedence order. */
export type SettingSource =
  | "flag"
  | "environment"
  | "project profile"
  | "project file"
  | "global profile"
  | "global file"
  | "default";

/** A resolved value and the reason it holds. */
export interface Resolved<T> {
  value: T;
  source: SettingSource;
  /** The file a `project file` or `global file` value was read from. */
  path?: string;
}

/** Output rendering, shared by every command in the family. */
export type OutputFormat = "pretty" | "json" | "raw";

/**
 * Environment for one profile: a file to load, or values written inline.
 *
 * A path is resolved against the project root rather than against the file
 * that declared it, because an env file is a project artefact and a path
 * relative to somebody's home directory would mean nothing on another
 * machine. The inline map is for a value that does not deserve a file.
 */
export type ProfileEnv = string | Record<string, string>;

/** The keys a profile carries, and the keys a file carries at its top level. */
export interface CraftSettingValues {
  /** Base URL of the instance's ops server. */
  url?: string;
  /** Bearer token presented to the management door and to health. */
  token?: string;
  /** Default output format. */
  format?: OutputFormat;
  /** Which agent `craft acp` asks the instance to talk to. */
  agent?: string;
  /** The environment this profile selects. */
  env?: ProfileEnv;
}

/** What the settings file may carry. Every key is optional. */
export interface CraftSettings extends CraftSettingValues {
  /** The profile selected when no flag and no environment variable name one. */
  profile?: string;
  /** Named sets of the values above. */
  profiles?: Record<string, CraftSettingValues>;
}

/** Flags that override the file, per command invocation. */
export interface SettingsOverrides {
  url?: string;
  token?: string;
  format?: string;
  /** The agent `craft acp` asks for. */
  agent?: string;
  /** Which profile to select, above every other way of choosing one. */
  profile?: string;
  /**
   * Directory the project-local settings file is looked for under.
   * Defaults to the working directory; pinned by tests so a developer's
   * own settings file cannot supply a credential to a case whose whole
   * point is that none was presented.
   */
  cwd?: string;
  /** Environment to read. Defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory the global settings file is looked for under. Defaults to the
   * user's home. Pinned by tests for the same reason as `cwd`: a developer's
   * own `~/.routecraft/settings.yaml` would otherwise decide what a case
   * about defaults resolves to.
   */
  home?: string;
}

/** Everything a command needs, each value carrying its provenance. */
export interface ResolvedSettings {
  url: Resolved<string>;
  token: Resolved<string> | undefined;
  format: Resolved<OutputFormat>;
  /** The agent `craft acp` asks for, when one was named. */
  agent: Resolved<string> | undefined;
  /**
   * The selected profile, when one was selected. The value is its name and
   * the source says who chose it, which is the first thing to check when a
   * command reaches an instance nobody expected.
   */
  profile: Resolved<string> | undefined;
  /** The environment the selected profile names, when it names one. */
  env: Resolved<ProfileEnv> | undefined;
}

/**
 * Address used when nothing names one.
 *
 * The ops surface mounts on the `default` server unless configured
 * elsewhere, and `8080` is that server's conventional port throughout the
 * documentation. Loopback rather than a hostname, because a bare `craft
 * ops health` means "the instance I am running here".
 */
export const DEFAULT_URL = "http://127.0.0.1:8080";

/**
 * File names looked for in both locations, in preference order. `.yaml` is
 * the documented spelling; `.yml` is accepted because half the world types
 * it. Order only names the default for a fresh location: when both exist
 * the resolver refuses rather than silently preferring one, because a
 * setting edited in the file that is not being read is a debugging trap
 * with nothing to say for itself.
 */
const SETTINGS_FILES = [
  join(".routecraft", "settings.yaml"),
  join(".routecraft", "settings.yml"),
] as const;

/**
 * Resolve which settings file one location uses, or refuse when the answer
 * is ambiguous. A location with neither file resolves to the canonical
 * `.yaml` path so error messages and provenance still name a real place.
 */
function resolveSettingsPath(resolveIn: (file: string) => string): string {
  const candidates = SETTINGS_FILES.map(resolveIn);
  const present = candidates.filter((path) => existsSync(path));
  if (present.length > 1) {
    throw new SettingsError(
      `Both ${present[0]} and ${present[1]} exist. Settings are read from exactly one file per location; keep one and remove the other.`,
    );
  }
  return present[0] ?? candidates[0]!;
}

const FORMATS: readonly OutputFormat[] = ["pretty", "json", "raw"];

/** Environment variables read between the flags and the files. */
const ENV_URL = "CRAFT_URL";
const ENV_TOKEN = "CRAFT_TOKEN";
const ENV_FORMAT = "CRAFT_FORMAT";
const ENV_AGENT = "CRAFT_AGENT";
const ENV_PROFILE = "CRAFT_PROFILE";

/** A settings file that exists but cannot be used. */
export class SettingsError extends Error {}

/**
 * A blank flag or environment value, read as not supplied.
 *
 * `--url "$CRAFT_URL"` with the variable unset, and an exported `CRAFT_URL=`,
 * both arrive as an empty string; treating one as supplied lets it win the
 * precedence it never earned and silently override the settings file with
 * nothing. Trimmed rather than merely tested, so a value pasted with a
 * trailing newline is not refused as invalid with nothing to suggest the
 * whitespace is why.
 *
 * A blank value written into a settings file is not this: somebody typed it
 * there, and the refusal is what tells them.
 */
export function supplied(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Read one settings file, or `undefined` when it is not there.
 *
 * A missing file is the normal case and says nothing. A file that exists
 * and cannot be parsed is an error rather than a silent fallback: an
 * operator who wrote a settings file and got default behaviour would
 * reasonably conclude the setting does not work.
 */
function readSettingsFile(path: string): CraftSettings | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    // Only "it is not there" means no settings. A file that exists and cannot
    // be read (no permission, or the path is a directory) is the same class of
    // problem as one that cannot be parsed: the operator wrote settings and
    // would otherwise get default behaviour with nothing said.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new SettingsError(
      `${path} exists but could not be read: ${messageOf(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error: unknown) {
    // First line only: the parser's message appends a code frame quoting the
    // offending source line, and in this file that line can be the token.
    // stderr is often captured (CI logs), so the credential must not ride
    // along with the diagnosis.
    const firstLine = messageOf(error).split("\n", 1)[0];
    throw new SettingsError(`${path} is not valid YAML: ${firstLine}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError(
      `${path} must contain a mapping of settings (for example \`url: http://127.0.0.1:8080\`).`,
    );
  }
  // `profiles` is checked here, at the boundary, because every other key
  // this file reads is guarded and an unguarded one fails silently rather
  // than loudly: `profiles: local` makes a string whose character indices
  // read as profile names, and a scalar entry makes a profile whose every
  // setting is undefined, which resolves to the defaults while looking
  // like it was honoured.
  const profiles = (parsed as { profiles?: unknown }).profiles;
  // `profiles:` with nothing after it parses as null, which is somebody
  // starting a map and not finishing it rather than somebody declaring
  // none. Normalised away here so nothing downstream meets it: the reader
  // that did threw a raw TypeError instead of naming the file.
  if (profiles === null) delete (parsed as { profiles?: unknown }).profiles;
  if (profiles !== undefined && profiles !== null) {
    if (!isPlainObject(profiles)) {
      throw new SettingsError(
        `The "profiles" in ${path} must be a map of profile names to their settings.`,
      );
    }
    for (const [name, entry] of Object.entries(profiles)) {
      if (entry === undefined || entry === null) continue;
      if (!isPlainObject(entry)) {
        throw new SettingsError(
          `The profile "${name}" in ${path} must be a map of settings, not a single value.`,
        );
      }
    }
  }
  return parsed as CraftSettings;
}

function assertFormat(value: string, where: string): OutputFormat {
  if ((FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new SettingsError(
    `${where} must be one of ${FORMATS.join(", ")}; received "${value}".`,
  );
}

/**
 * Resolve the effective settings for one invocation.
 *
 * @param overrides - Flags given on the command line
 * @param cwd - Working directory the project-local file is looked for under
 * @param env - Environment to read, injectable for tests
 */
export function resolveSettings(
  overrides: SettingsOverrides = {},
): ResolvedSettings {
  const cwd = overrides.cwd ?? process.cwd();
  const env = overrides.env ?? process.env;
  const projectPath = resolveSettingsPath((file) => resolve(cwd, file));
  const home = overrides.home ?? homedir();
  const globalPath = resolveSettingsPath((file) => join(home, file));
  const project = readSettingsFile(projectPath);
  // A project file that IS the global file (running in the home directory)
  // must not be reported as two independent sources agreeing.
  const global =
    projectPath === globalPath ? undefined : readSettingsFile(globalPath);

  const profile = pickProfile(
    overrides.profile,
    env[ENV_PROFILE],
    { settings: project, path: projectPath },
    { settings: global, path: globalPath },
  );

  /**
   * One value, through the whole chain.
   *
   * Flag, then environment, then per file: the selected profile before
   * that file's own top level. Environment variables sit above every file
   * because what somebody changes on a server is what has to win, and it
   * is already how this CLI behaves. Inside a file the profile is the more
   * specific answer; between files the project still beats the home
   * directory, so a profile in a home directory can never redirect an
   * instance a repository pinned.
   */
  const pick = <K extends keyof CraftSettingValues>(
    key: K,
    flag: string | undefined,
    fromEnvironment: string | undefined,
  ): Resolved<NonNullable<CraftSettingValues[K]>> | undefined => {
    const fromFlag = supplied(flag);
    const fromEnv = supplied(fromEnvironment);
    if (fromFlag !== undefined) {
      return {
        value: fromFlag as NonNullable<CraftSettingValues[K]>,
        source: "flag",
      };
    }
    if (fromEnv !== undefined) {
      return {
        value: fromEnv as NonNullable<CraftSettingValues[K]>,
        source: "environment",
      };
    }
    const layers: Array<{
      values: CraftSettingValues | undefined;
      source: SettingSource;
      path: string;
    }> = [
      {
        values: profileIn(project, profile?.value),
        source: "project profile",
        path: projectPath,
      },
      { values: project, source: "project file", path: projectPath },
      {
        values: profileIn(global, profile?.value),
        source: "global profile",
        path: globalPath,
      },
      { values: global, source: "global file", path: globalPath },
    ];
    for (const layer of layers) {
      const value = layer.values?.[key];
      if (value !== undefined) {
        return {
          value: value as NonNullable<CraftSettingValues[K]>,
          source: layer.source,
          path: layer.path,
        };
      }
    }
    return undefined;
  };

  const url = pick("url", overrides.url, env[ENV_URL]) ?? {
    value: DEFAULT_URL,
    source: "default" as const,
  };
  if (typeof url.value !== "string" || url.value.trim() === "") {
    throw new SettingsError(
      `The instance URL from the ${describeSource(url)} is empty. Give a full base URL, for example http://127.0.0.1:8080.`,
    );
  }
  // A typo'd address is invalid configuration, not an instance that is down.
  // Reaching `fetch()` with it would report "could not reach a running
  // instance", sending the reader to look at a server that is fine.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.value);
  } catch {
    throw new SettingsError(
      `The instance URL from the ${describeSource(url)} is not a URL: "${url.value}". Give a full base URL, for example http://127.0.0.1:8080.`,
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new SettingsError(
      `The instance URL from the ${describeSource(url)} uses "${parsedUrl.protocol}"; the ops server is reached over http or https.`,
    );
  }

  const token = pick("token", overrides.token, env[ENV_TOKEN]);
  if (token !== undefined && typeof token.value !== "string") {
    throw new SettingsError(
      `The token from the ${token.source} must be a string.`,
    );
  }
  // The file half of the blank rule, and the reason it is checked here: a
  // blank flag or environment value never reaches this point, so a blank
  // token can only have been written into a file by hand. Left alone it
  // presents `Bearer` with nothing after it and the operator is told their
  // credential was rejected.
  if (token !== undefined && token.value.trim() === "") {
    throw new SettingsError(
      `The token from the ${describeSource(token)} is empty. Put a credential there, or remove the key.`,
    );
  }

  const formatRaw = pick("format", overrides.format, env[ENV_FORMAT]);
  const format: Resolved<OutputFormat> =
    formatRaw === undefined
      ? { value: "pretty", source: "default" }
      : {
          ...formatRaw,
          value: assertFormat(
            String(formatRaw.value),
            `The output format from the ${formatRaw.source}`,
          ),
        };

  const agent = pick("agent", overrides.agent, env[ENV_AGENT]);
  if (agent !== undefined && typeof agent.value !== "string") {
    throw new SettingsError(
      `The agent name from the ${describeSource(agent)} must be a string.`,
    );
  }
  if (agent !== undefined && agent.value.trim() === "") {
    throw new SettingsError(
      `The agent name from the ${describeSource(agent)} is empty. Name an agent, or remove the key.`,
    );
  }

  const envValue = pickEnv(profile, project, projectPath, global, globalPath);

  return {
    url,
    token,
    format,
    agent,
    profile,
    env: envValue,
  };
}

/**
 * Which profile is selected, and who chose it.
 *
 * A profile named by anybody has to exist somewhere, and the refusal names
 * the profiles that do: a typo would otherwise resolve to the defaults and
 * reach an instance nobody meant.
 */
function pickProfile(
  flag: string | undefined,
  fromEnvironment: string | undefined,
  project: { settings: CraftSettings | undefined; path: string },
  global: { settings: CraftSettings | undefined; path: string },
): Resolved<string> | undefined {
  const known = new Set([
    ...Object.keys(project.settings?.profiles ?? {}),
    ...Object.keys(global.settings?.profiles ?? {}),
  ]);
  const describeKnown = (): string =>
    known.size === 0
      ? "no profiles are defined in either settings file"
      : `defined profiles: ${[...known].sort().join(", ")}`;

  const chosen: Resolved<string> | undefined =
    supplied(flag) !== undefined
      ? { value: supplied(flag)!, source: "flag" }
      : supplied(fromEnvironment) !== undefined
        ? { value: supplied(fromEnvironment)!, source: "environment" }
        : project.settings?.profile !== undefined
          ? {
              value: project.settings.profile,
              source: "project file",
              path: project.path,
            }
          : global.settings?.profile !== undefined
            ? {
                value: global.settings.profile,
                source: "global file",
                path: global.path,
              }
            : undefined;

  if (chosen === undefined) return undefined;
  if (typeof chosen.value !== "string" || chosen.value.trim() === "") {
    throw new SettingsError(
      `The profile from the ${describeSource(chosen)} is not a name; ${describeKnown()}.`,
    );
  }
  if (!known.has(chosen.value)) {
    throw new SettingsError(
      `No profile "${chosen.value}" (named by the ${describeSource(chosen)}); ${describeKnown()}.`,
    );
  }
  return chosen;
}

/** One file's entry for the selected profile, when it has one. */
function profileIn(
  settings: CraftSettings | undefined,
  profile: string | undefined,
): CraftSettingValues | undefined {
  if (settings === undefined || profile === undefined) return undefined;
  const profiles = settings.profiles;
  if (profiles === undefined) return undefined;
  // `readSettingsFile` refuses a `profiles` that is not a map of maps, and
  // normalises the empty `profiles:` to absent, so what reaches here is a
  // map or nothing.
  return Object.prototype.hasOwnProperty.call(profiles, profile)
    ? profiles[profile]
    : undefined;
}

/**
 * The environment the selected profile names, if it names one.
 *
 * Not part of `pick` because it is not a string: it is a path or an inline
 * map, and there is no environment variable or flag form of it. `--env`
 * wins over it and is handled by the commands that take one, because the
 * flag names a file to load rather than a setting to resolve.
 */
function pickEnv(
  profile: Resolved<string> | undefined,
  project: CraftSettings | undefined,
  projectPath: string,
  global: CraftSettings | undefined,
  globalPath: string,
): Resolved<ProfileEnv> | undefined {
  const layers: Array<{
    values: CraftSettingValues | undefined;
    source: SettingSource;
    path: string;
  }> = [
    {
      values: profileIn(project, profile?.value),
      source: "project profile",
      path: projectPath,
    },
    { values: project, source: "project file", path: projectPath },
    {
      values: profileIn(global, profile?.value),
      source: "global profile",
      path: globalPath,
    },
    { values: global, source: "global file", path: globalPath },
  ];
  for (const layer of layers) {
    const value = layer.values?.env;
    if (value === undefined) continue;
    // An empty string is not a path. Left alone it resolves to the project
    // directory and the command runs on without the environment the person
    // selected, which is the silence this file exists to refuse.
    const empty = typeof value === "string" && value.trim() === "";
    if ((typeof value !== "string" && !isPlainStringMap(value)) || empty) {
      throw new SettingsError(
        `The "env" in ${layer.path} must be a path to an env file or a map of names to string values.`,
      );
    }
    return { value, source: layer.source, path: layer.path };
  }
  return undefined;
}

/** Whether a value is a flat map of strings, which is what an inline env is. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Describe where a value came from, for an error a reader has to act on.
 * A wrong pinned address should be diagnosable from the message alone,
 * without the reader guessing which of four places supplied it.
 */
export function describeSource(resolved: Resolved<unknown>): string {
  return resolved.path === undefined
    ? resolved.source
    : `${resolved.source} ${resolved.path}`;
}
