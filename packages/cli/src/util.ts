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
 * Loads environment variables from .env files
 *
 * An explicit `path` always resolves against the working directory,
 * because that is what a relative path typed on the command line means.
 * The conventional `.env` / `.env.local` pair resolves against
 * `defaultsFrom`, so `craft start ./apps/eywa` picks up that project's
 * own environment rather than the one beside the shell.
 *
 * @param notes Collects what the load has to report; see {@link EnvironmentNote}
 * @param path Optional path to .env file. If not specified, loads .env, the selected profile's `.env.<profile>`, and .env.local (each if it exists)
 * @param defaultsFrom Directory the conventional .env files are read from. Defaults to the working directory
 * @param profile The selected profile, which names the middle file of the cascade
 */
function loadEnvFile(
  notes: EnvironmentNote[],
  path?: string,
  defaultsFrom: string = process.cwd(),
  profile?: string,
): void {
  // dotenv reports a missing file as an error beside an empty `parsed`, so
  // the error is checked first or every absent file reads as "loaded 0".
  const dotenvOpts = { quiet: true };
  if (path) {
    const envPath = resolve(process.cwd(), path);
    const result = loadDotenv({ path: envPath, ...dotenvOpts });

    if (result.error) {
      notes.push({
        level: "info",
        message: `Could not load .env file from ${path}: ${result.error.message}`,
      });
    } else if (result.parsed) {
      notes.push({
        level: "debug",
        message: `Loaded ${Object.keys(result.parsed).length} environment variables from ${path}`,
      });
    }
    return;
  }

  // .env, then the profile's own file, then .env.local, each overriding
  // the one before.
  const envResult = loadDotenv({
    path: resolve(defaultsFrom, ".env"),
    ...dotenvOpts,
  });
  if (envResult.error) {
    notes.push({ level: "debug", message: "No .env file found" });
  } else if (envResult.parsed) {
    notes.push({
      level: "debug",
      message: `Loaded ${Object.keys(envResult.parsed).length} environment variables from .env`,
    });
  }

  // The profile is the mode: `--profile ing` reads `.env.ing` between the
  // pair, so one selection picks the instance and its environment together.
  if (profile !== undefined) {
    const profileResult = loadDotenv({
      path: resolve(defaultsFrom, `.env.${profile}`),
      override: true,
      ...dotenvOpts,
    });
    if (!profileResult.error && profileResult.parsed) {
      notes.push({
        level: "debug",
        message: `Loaded ${Object.keys(profileResult.parsed).length} environment variables from .env.${profile}`,
      });
    }
  }

  const envLocalResult = loadDotenv({
    path: resolve(defaultsFrom, ".env.local"),
    override: true,
    ...dotenvOpts,
  });
  if (!envLocalResult.error && envLocalResult.parsed) {
    notes.push({
      level: "debug",
      message: `Loaded ${Object.keys(envLocalResult.parsed).length} environment variables from .env.local`,
    });
  }
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
 */
export function loadEnvironment(
  selection: EnvironmentSelection,
): EnvironmentNote[] {
  const notes: EnvironmentNote[] = [];
  const defaultsFrom = selection.defaultsFrom ?? process.cwd();
  if (selection.explicit !== undefined) {
    loadEnvFile(notes, selection.explicit);
    return notes;
  }
  const env = selection.env;
  if (typeof env === "string") {
    // Against the project root rather than the declaring file: an env file
    // is a project artefact, and a path relative to somebody's home
    // directory would name nothing on another machine.
    loadEnvFile(notes, resolve(defaultsFrom, env), defaultsFrom);
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
  loadEnvFile(notes, undefined, defaultsFrom, selection.profile);
  return notes;
}
