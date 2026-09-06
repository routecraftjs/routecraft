import { logger } from "@routecraft/routecraft";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import type { ProfileEnv } from "./settings.js";

/**
 * Loads environment variables from .env files
 *
 * An explicit `path` always resolves against the working directory,
 * because that is what a relative path typed on the command line means.
 * The conventional `.env` / `.env.local` pair resolves against
 * `defaultsFrom`, so `craft start ./apps/eywa` picks up that project's
 * own environment rather than the one beside the shell.
 *
 * @param path Optional path to .env file. If not specified, loads .env, the selected profile's `.env.<profile>`, and .env.local (each if it exists)
 * @param defaultsFrom Directory the conventional .env files are read from. Defaults to the working directory
 * @param profile The selected profile, which names the middle file of the cascade
 * @returns The parsed dotenv config result
 */
export function loadEnvFile(
  path?: string,
  defaultsFrom: string = process.cwd(),
  profile?: string,
) {
  const dotenvOpts = { quiet: true };
  if (path) {
    // Explicit path provided - load that file only
    const envPath = resolve(process.cwd(), path);
    const result = loadDotenv({ path: envPath, ...dotenvOpts });

    if (result.error) {
      logger.info(
        `Could not load .env file from ${path}: ${result.error.message}`,
      );
    } else if (result.parsed) {
      logger.debug(
        `Loaded ${Object.keys(result.parsed).length} environment variables from ${path}`,
      );
    }

    return result;
  }

  // No path provided - load .env, then the profile's own file, then
  // .env.local (each overriding the one before)
  const envResult = loadDotenv({
    path: resolve(defaultsFrom, ".env"),
    ...dotenvOpts,
  });
  if (envResult.parsed) {
    logger.debug(
      `Loaded ${Object.keys(envResult.parsed).length} environment variables from .env`,
    );
  } else if (envResult.error) {
    logger.debug(`No .env file found`);
  }

  // The profile is the mode: `--profile ing` reads `.env.ing` between the
  // pair, so one selection picks the instance and its environment together.
  let profileResult: ReturnType<typeof loadDotenv> | undefined;
  if (profile !== undefined) {
    profileResult = loadDotenv({
      path: resolve(defaultsFrom, `.env.${profile}`),
      override: true,
      ...dotenvOpts,
    });
    if (profileResult.parsed) {
      logger.debug(
        `Loaded ${Object.keys(profileResult.parsed).length} environment variables from .env.${profile}`,
      );
    }
  }

  // Load .env.local next, allowing it to override .env values
  const envLocalResult = loadDotenv({
    path: resolve(defaultsFrom, ".env.local"),
    override: true,
    ...dotenvOpts,
  });
  if (envLocalResult.parsed) {
    logger.debug(
      `Loaded ${Object.keys(envLocalResult.parsed).length} environment variables from .env.local`,
    );
  }

  // Return the most successful result:
  // - If .env.local loaded successfully, return it
  // - If .env loaded successfully but .env.local failed (doesn't exist), return .env result
  // - If both failed, return the last error (from .env.local)
  if (envLocalResult.parsed) {
    return envLocalResult;
  }
  // The profile's own file counts as a successful load: a project that
  // carries only `.env.<profile>` did load an environment, and reporting
  // the missing `.env.local` instead would say it did not.
  if (profileResult?.parsed) {
    return profileResult;
  }
  if (envResult.parsed) {
    return envResult;
  }
  return envLocalResult;
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
 */
export function loadEnvironment(selection: EnvironmentSelection): void {
  const defaultsFrom = selection.defaultsFrom ?? process.cwd();
  if (selection.explicit !== undefined) {
    loadEnvFile(selection.explicit);
    return;
  }
  const env = selection.env;
  if (typeof env === "string") {
    // Against the project root rather than the declaring file: an env file
    // is a project artefact, and a path relative to somebody's home
    // directory would name nothing on another machine.
    loadEnvFile(resolve(defaultsFrom, env), defaultsFrom);
    return;
  }
  if (env !== undefined) {
    for (const [name, value] of Object.entries(env)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
    logger.debug(
      `Applied ${Object.keys(env).length} inline environment values from the selected profile`,
    );
    return;
  }
  loadEnvFile(undefined, defaultsFrom, selection.profile);
}
