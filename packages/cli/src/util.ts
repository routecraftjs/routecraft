import { logger } from "@routecraft/routecraft";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Loads environment variables from .env files
 *
 * An explicit `path` always resolves against the working directory,
 * because that is what a relative path typed on the command line means.
 * The conventional `.env` / `.env.local` pair resolves against
 * `defaultsFrom`, so `craft start ./apps/eywa` picks up that project's
 * own environment rather than the one beside the shell.
 *
 * @param path Optional path to .env file. If not specified, loads .env and .env.local (if they exist)
 * @param defaultsFrom Directory the conventional .env files are read from. Defaults to the working directory
 * @returns The parsed dotenv config result
 */
export function loadEnvFile(
  path?: string,
  defaultsFrom: string = process.cwd(),
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

  // No path provided - load .env, then .env.local (with override)
  // Load .env first
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
