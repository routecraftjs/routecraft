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
  // Load .env first
  const envResult = loadDotenv({ path: resolve(process.cwd(), ".env") });
  if (envResult.parsed) {
    logger.debug(
      `Loaded ${Object.keys(envResult.parsed).length} environment variables from .env`,
    );
  } else if (envResult.error) {
    logger.debug(`No .env file found`);
  }

  // Load .env.local next, allowing it to override .env values
  const envLocalResult = loadDotenv({
    path: resolve(process.cwd(), ".env.local"),
    override: true,
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
