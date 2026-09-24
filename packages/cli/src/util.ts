import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import type { ProfileEnv } from "./settings.js";

/**
 * A line the environment loader has to report, held until the logger exists.
 *
 * Loading the environment is what configures the logger: core builds it when
 * it first loads, from `LOG_LEVEL` and `LOG_FILE` as they stand then, and an
 * env file is one of the places those come from. So nothing here may load
 * core, and the loader cannot log as it goes. The caller logs these once core
 * is loaded.
 */
export interface EnvironmentNote {
  level: "debug" | "info";
  message: string;
}

/**
 * An environment file that could not be loaded.
 *
 * Unlike the conventional `.env` cascade, where a missing file is skipped, a
 * file somebody named (`--env <path>`, or a profile's `env: "<file>"`) is
 * required: running on without it would start the command against an
 * environment nobody asked for.
 */
export class EnvFileError extends Error {}

const dotenvOpts = { quiet: true };

/**
 * Load one env file and note how many variables it set.
 *
 * @param notes Collects what the load has to report; see {@link EnvironmentNote}
 * @param path The file, absolute
 * @param label How the file is named in the note
 * @param override Whether the file wins over a variable the process already carries
 * @returns Why the file could not be loaded, or undefined when it was
 */
function loadEnvFile(
  notes: EnvironmentNote[],
  path: string,
  label: string,
  override = false,
): Error | undefined {
  const result = loadDotenv({ path, override, ...dotenvOpts });
  // dotenv returns an empty `parsed` beside the error for a missing file.
  if (result.error) return result.error;
  notes.push({
    level: "debug",
    message: `Loaded ${Object.keys(result.parsed ?? {}).length} environment variables from ${label}`,
  });
  return undefined;
}

/**
 * Load one named env file, refusing when it cannot be read.
 *
 * @param notes Collects what the load has to report; see {@link EnvironmentNote}
 * @param path The file, resolved against the working directory
 * @param origin Where the name came from, for the refusal message
 * @throws {EnvFileError} When the file cannot be loaded
 */
function loadNamedEnvFile(
  notes: EnvironmentNote[],
  path: string,
  origin: string,
): void {
  const error = loadEnvFile(notes, resolve(process.cwd(), path), path);
  if (error) {
    throw new EnvFileError(
      `Cannot load the environment file ${path} (from ${origin}): ${error.message}`,
    );
  }
}

/**
 * Load one file of the cascade, where absence is normal.
 *
 * @returns Whether the file was loaded
 * @throws {EnvFileError} When the file exists but cannot be read, which is
 * not absence: running on would silently drop settings somebody wrote
 */
function loadCascadeFile(
  notes: EnvironmentNote[],
  defaultsFrom: string,
  name: string,
  override: boolean,
): boolean {
  const error = loadEnvFile(notes, resolve(defaultsFrom, name), name, override);
  if (error === undefined) return true;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw new EnvFileError(
    `Cannot load the environment file ${name}: ${error.message}`,
  );
}

/**
 * Load the conventional cascade: `.env`, then `.env.<profile>` when a
 * profile is selected, then `.env.local`, each overriding the one before.
 * A missing file is skipped; one that exists but cannot be read is not.
 *
 * The files resolve against `defaultsFrom`, so `craft start ./apps/eywa`
 * picks up that project's own environment rather than the one beside the
 * shell.
 *
 * @param notes Collects what the load has to report; see {@link EnvironmentNote}
 * @param defaultsFrom Directory the conventional .env files are read from
 * @param profile The selected profile, which names the middle file of the cascade
 * @throws {EnvFileError} When a file of the cascade exists but cannot be read
 */
function loadEnvCascade(
  notes: EnvironmentNote[],
  defaultsFrom: string,
  profile?: string,
): void {
  if (!loadCascadeFile(notes, defaultsFrom, ".env", false)) {
    notes.push({ level: "debug", message: "No .env file found" });
  }
  // The profile is the mode: `--profile ing` reads `.env.ing` between the
  // pair, so one selection picks the instance and its environment together.
  if (profile !== undefined) {
    loadCascadeFile(notes, defaultsFrom, `.env.${profile}`, true);
  }
  loadCascadeFile(notes, defaultsFrom, ".env.local", true);
}

/**
 * Turn a thrown value into a printable message. Non-Error throws (Bun's
 * `ResolveMessage` for a missing package, most usefully) still carry a
 * message, so surfacing it beats reporting "Unknown error". Shared by
 * `run` and `start` because both fail the same ways.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

/**
 * What decides the environment for one invocation.
 *
 * The profile IS the mode: selecting one selects the environment files
 * that go with it, so there is one concept to learn rather than two
 * overlapping ones. `--env` still wins, because a path typed on the
 * command line is the most specific thing anybody said.
 */
export interface EnvironmentSelection {
  /** `--env <path>`, resolved against the working directory. */
  explicit?: string | undefined;
  /** The selected profile's name, which names the middle file of the cascade. */
  profile?: string | undefined;
  /** What the selected profile says about its environment, if anything. */
  env?: ProfileEnv | undefined;
  /** Directory the conventional files are read from. */
  defaultsFrom?: string;
}

/**
 * Load the environment for one invocation, in the order the settings
 * documentation states.
 *
 * 1. `--env <path>`: that file, and nothing else.
 * 2. The selected profile's `env`: one exact file, or an inline map.
 * 3. The cascade: `.env`, then `.env.<profile>` when a profile is
 *    selected, then `.env.local`, each overriding the one before.
 *
 * An inline map does not override a variable the process already carries,
 * matching how a `.env` file behaves: what is exported on a server wins
 * over what a settings file suggests.
 *
 * @returns What the load has to report, for the caller to log once core is loaded
 * @throws {EnvFileError} When a named file (`--env`, or a profile's `env` path) cannot be loaded, or a cascade file exists but cannot be read
 */
export function loadEnvironment(
  selection: EnvironmentSelection,
): EnvironmentNote[] {
  const notes: EnvironmentNote[] = [];
  const defaultsFrom = selection.defaultsFrom ?? process.cwd();
  if (selection.explicit !== undefined) {
    loadNamedEnvFile(notes, selection.explicit, "--env");
    return notes;
  }
  const env = selection.env;
  if (typeof env === "string") {
    // Against the project root rather than the declaring file: an env file
    // is a project artefact, and a path relative to somebody's home
    // directory would name nothing on another machine.
    loadNamedEnvFile(
      notes,
      resolve(defaultsFrom, env),
      "the selected profile's env",
    );
    return notes;
  }
  if (env !== undefined) {
    for (const [name, value] of Object.entries(env)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
    notes.push({
      level: "debug",
      message: `Applied ${Object.keys(env).length} inline environment values from the selected profile`,
    });
    return notes;
  }
  loadEnvCascade(notes, defaultsFrom, selection.profile);
  return notes;
}
