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
 * Project-local wins over global, an environment variable wins over both,
 * and a flag wins over everything. `.routecraft/` is already gitignored,
 * which is what keeps a pasted token out of a commit; the scaffolder half
 * of that lives in #588.
 *
 * Every resolved value remembers where it came from, because the one
 * question a failed connection has to answer is "which address did it
 * actually use, and who told it that".
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { messageOf } from "./util.js";

/** Where a resolved value came from, in precedence order. */
export type SettingSource =
  "flag" | "environment" | "project file" | "global file" | "default";

/** A resolved value and the reason it holds. */
export interface Resolved<T> {
  value: T;
  source: SettingSource;
  /** The file a `project file` or `global file` value was read from. */
  path?: string;
}

/** Output rendering, shared by every command in the family. */
export type OutputFormat = "pretty" | "json" | "raw";

/** What the settings file may carry. Every key is optional. */
export interface CraftSettings {
  /** Base URL of the instance's ops server. */
  url?: string;
  /** Bearer token presented to the management door and to health. */
  token?: string;
  /** Default output format. */
  format?: OutputFormat;
}

/** Flags that override the file, per command invocation. */
export interface SettingsOverrides {
  url?: string;
  token?: string;
  format?: string;
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

/** File name looked for in both locations. */
const SETTINGS_FILE = join(".routecraft", "settings.yaml");

const FORMATS: readonly OutputFormat[] = ["pretty", "json", "raw"];

/** Environment variables read between the flags and the files. */
const ENV_URL = "CRAFT_URL";
const ENV_TOKEN = "CRAFT_TOKEN";
const ENV_FORMAT = "CRAFT_FORMAT";

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
    throw new SettingsError(`${path} is not valid YAML: ${messageOf(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError(
      `${path} must contain a mapping of settings (for example \`url: http://127.0.0.1:8080\`).`,
    );
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
  const projectPath = resolve(cwd, SETTINGS_FILE);
  const globalPath = join(overrides.home ?? homedir(), SETTINGS_FILE);
  const project = readSettingsFile(projectPath);
  // A project file that IS the global file (running in the home directory)
  // must not be reported as two independent sources agreeing.
  const global =
    projectPath === globalPath ? undefined : readSettingsFile(globalPath);

  const pick = <K extends keyof CraftSettings>(
    key: K,
    flag: string | undefined,
    env: string | undefined,
  ): Resolved<NonNullable<CraftSettings[K]>> | undefined => {
    const fromFlag = supplied(flag);
    const fromEnv = supplied(env);
    if (fromFlag !== undefined) {
      return {
        value: fromFlag as NonNullable<CraftSettings[K]>,
        source: "flag",
      };
    }
    if (fromEnv !== undefined) {
      return {
        value: fromEnv as NonNullable<CraftSettings[K]>,
        source: "environment",
      };
    }
    if (project?.[key] !== undefined) {
      return {
        value: project[key] as NonNullable<CraftSettings[K]>,
        source: "project file",
        path: projectPath,
      };
    }
    if (global?.[key] !== undefined) {
      return {
        value: global[key] as NonNullable<CraftSettings[K]>,
        source: "global file",
        path: globalPath,
      };
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

  return { url, token, format };
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
