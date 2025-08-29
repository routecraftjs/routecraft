import {
  logger,
  CraftContext,
  type CraftConfig,
} from "@routecraftjs/routecraft";
import {
  loadModuleWithDefaultExport,
  registerContextSignalHandlers,
} from "./util";
import chokidar, { FSWatcher } from "chokidar";
import { resolve } from "node:path";

/**
 * Start a Routecraft context from a config file.
 *
 * @param configPath Path to a config file exporting a CraftConfig as default
 * @param watch If true, restart on file changes
 */
export async function startCommand(configPath: string, watch = false) {
  const absConfigPath = resolve(process.cwd(), configPath);
  let context: CraftContext | undefined;
  let watcher: FSWatcher | undefined;

  async function startContext(pathOverride?: string) {
    try {
      // Use a cache-busting query string if provided
      const importPath = pathOverride || absConfigPath;
      const config = await loadModuleWithDefaultExport(importPath);
      logger.info(`Successfully loaded config from ${importPath}`);

      // Create the Routecraft context from the config
      context = new CraftContext(config as CraftConfig);

      // Add signal handlers for graceful shutdown
      registerContextSignalHandlers(context);

      // Start the context
      await context.start();
    } catch (error) {
      logger.error(
        error instanceof Error && error.stack
          ? `Failed to start context: ${error.message}\n${error.stack}`
          : `Failed to start context: ${error}`,
      );
      process.exit(1);
    }
  }

  async function stopContext() {
    if (context) {
      await context.stop();
      context = undefined;
    }
  }

  if (watch) {
    // Watch the config file for changes and restart on change
    watcher = chokidar.watch(absConfigPath, { ignoreInitial: true });
    watcher.on("change", async (path: string) => {
      logger.info(`Detected change in ${path}, restarting context...`);
      await stopContext();
      // Use a cache-busting query string to force ESM reload
      await startContext(`${absConfigPath}?update=${Date.now()}`);
    });
    logger.info(`Watching ${absConfigPath} for changes...`);
  }

  await startContext();
}
