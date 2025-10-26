import { logger, CraftContext } from "@routecraft/routecraft";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Loads environment variables from .env files
 *
 * @param path Optional path to .env file. If not specified, looks for .env in current directory
 * @returns The parsed dotenv config result
 */
export function loadEnvFile(path?: string) {
  const envPath = path ? resolve(process.cwd(), path) : undefined;
  const result = loadDotenv(envPath ? { path: envPath } : {});

  if (result.error) {
    logger.warn(
      `Error loading .env file${path ? ` from ${path}` : ""}: ${result.error.message}`,
    );
  } else if (result.parsed) {
    logger.debug(
      `Loaded ${Object.keys(result.parsed).length} environment variables${path ? ` from ${path}` : ""}`,
    );
  }

  return result;
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
