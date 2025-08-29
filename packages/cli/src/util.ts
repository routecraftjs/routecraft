import { logger, CraftContext } from "@routecraftjs/routecraft";
import { stat as fsStat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Supported config file extensions for dynamic import.
 */
export const SUPPORTED_EXTENSIONS: string[] = [".ts", ".mjs", ".js", ".cjs"];

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
 * Loads a module from the given path, checks for a default export, and returns it.
 * Throws an error with helpful messages if not found or invalid.
 *
 * @param filePath Path to the module file (may include cache-busting query string)
 * @returns The default export of the module
 */
export async function loadModuleWithDefaultExport(
  filePath: string,
): Promise<unknown> {
  // Remove query string for fs operations
  const [fsPath] = filePath.split("?");
  const absPath = resolve(fsPath);
  logger.debug(`Resolved file path: ${absPath}`);
  const stat = await fsStat(absPath);
  if (!stat.isFile()) {
    throw new Error(`File not found: ${absPath}`);
  }
  const ext = extname(absPath);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file extension: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }
  logger.debug(`Importing module: ${filePath}`);
  const mod = await import(filePath); // Use cache-busted path here
  if (!mod.default) {
    throw new Error(`No default export found in file: ${absPath}`);
  }
  return mod.default;
}

/**
 * Registers SIGINT, SIGTERM, and exit handlers for a CraftContext instance.
 * Ensures graceful shutdown and logging.
 *
 * @param context The CraftContext instance
 */
export function registerContextSignalHandlers(context: CraftContext) {
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
