import { logger, CraftContext } from "@routecraft/routecraft";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Loads environment variables from .env files
 *
 * @param path Optional path to .env file. If not specified, loads .env and .env.local (if they exist)
 * @returns The parsed dotenv config result
 */
export function loadEnvFile(path?: string) {
  if (path) {
    // Explicit path provided - load that file only
    const envPath = resolve(process.cwd(), path);
    const result = loadDotenv({ path: envPath });

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
  let lastResult;

  // Load .env first
  lastResult = loadDotenv({ path: resolve(process.cwd(), ".env") });
  if (lastResult.parsed) {
    logger.debug(
      `Loaded ${Object.keys(lastResult.parsed).length} environment variables from .env`,
    );
  } else if (lastResult.error) {
    logger.debug(`No .env file found`);
  }

  // Load .env.local next, allowing it to override .env values
  lastResult = loadDotenv({
    path: resolve(process.cwd(), ".env.local"),
    override: true,
  });
  if (lastResult.parsed) {
    logger.debug(
      `Loaded ${Object.keys(lastResult.parsed).length} environment variables from .env.local`,
    );
  }

  return lastResult;
}

/**
 * Registers SIGINT, SIGTERM, and exit handlers for a CraftContext instance.
 * Ensures graceful shutdown and logging.
 *
 * @param context The CraftContext instance
 */
export function registerContextSignalHandlers(
  context: InstanceType<typeof CraftContext>,
) {
  process.on("SIGINT", async () => {
    context.logger.info("Shutting down (SIGINT)...");
    await context.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    context.logger.info("Shutting down (SIGTERM)...");
    await context.stop();
    process.exit(0);
  });
  process.on("exit", () => {
    context.logger.info("Cleanup complete");
  });
}
