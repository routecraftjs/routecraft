import { readdir, stat as fsStat } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  ContextBuilder,
  type RouteDefinition,
  logger,
} from "@routecraftjs/routecraft";
import { minimatch } from "minimatch";
import {
  loadModuleWithDefaultExport,
  registerContextSignalHandlers,
} from "./util";
import chokidar, { FSWatcher } from "chokidar";

const SUPPORTED_EXTENSIONS = [".ts", ".mjs", ".js", ".cjs"] as const;

async function* walkFiles(
  dir: string,
  excludePatterns: string[] = [],
): AsyncGenerator<string> {
  const files = await readdir(dir, { withFileTypes: true });
  for (const file of files) {
    const path = join(dir, file.name);

    // Check if the path matches any exclude pattern
    const isExcluded = excludePatterns.some((pattern) =>
      minimatch(path, pattern, { matchBase: true }),
    );

    if (isExcluded) {
      logger.debug(`Skipping excluded file: ${path}`);
      continue;
    }

    if (file.isDirectory()) {
      yield* walkFiles(path, excludePatterns);
    } else if (SUPPORTED_EXTENSIONS.some((ext) => file.name.endsWith(ext))) {
      yield path;
    }
  }
}

export async function runCommand(
  path?: string,
  exclude: string[] = [],
  watch = false,
) {
  const absTargetPath = path ? resolve(process.cwd(), path) : process.cwd();
  let context: ReturnType<ContextBuilder["build"]> | undefined;
  let watcher: FSWatcher | undefined;
  let watchedFiles: string[] = [];

  async function buildContextAndFiles(cacheBuster?: string) {
    const stat = await fsStat(absTargetPath);
    const contextBuilder = new ContextBuilder();
    watchedFiles = [];

    if (stat.isDirectory()) {
      // Handle directory case - find all supported files, excluding patterns
      for await (const filePath of walkFiles(absTargetPath, exclude)) {
        await configureRoutes(contextBuilder, filePath, cacheBuster);
        watchedFiles.push(filePath);
      }
    } else if (stat.isFile()) {
      // Handle single file case
      if (!SUPPORTED_EXTENSIONS.some((ext) => absTargetPath.endsWith(ext))) {
        logger.error(
          `Error: Only the following file types are supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
        );
        process.exit(1);
      }

      // Check if the single file should be excluded
      const isExcluded = exclude.some((pattern) =>
        minimatch(absTargetPath, pattern, { matchBase: true }),
      );

      if (!isExcluded) {
        await configureRoutes(contextBuilder, absTargetPath, cacheBuster);
        watchedFiles.push(absTargetPath);
      } else {
        logger.debug(`Skipping excluded file: ${absTargetPath}`);
      }
    }

    context = contextBuilder.build();
  }

  async function startContext(cacheBuster?: string) {
    await buildContextAndFiles(cacheBuster);
    registerContextSignalHandlers(context!);
    await context!.start();
  }

  async function stopContext() {
    if (context) {
      await context.stop();
      context = undefined;
    }
  }

  if (watch) {
    await buildContextAndFiles();
    watcher = chokidar.watch(watchedFiles, { ignoreInitial: true });
    watcher.on("change", async (changedPath: string) => {
      logger.info(`Detected change in ${changedPath}, restarting context...`);
      await stopContext();
      // Use a cache-busting query string to force ESM reload
      await startContext(`?update=${Date.now()}`);
    });
    logger.info(`Watching files for changes...\n${watchedFiles.join("\n")}`);
    await startContext();
  } else {
    await startContext();
    // Only wait on abort if there are still active routes
    if (context!.getRoutes().some((route) => !route.signal.aborted)) {
      await new Promise((_, reject) => {
        // No abort controller here, but could be added for symmetry
        process.on("SIGINT", () => reject(new Error("Aborted")));
        process.on("SIGTERM", () => reject(new Error("Aborted")));
      });
    }
  }
}

async function configureRoutes(
  contextBuilder: ContextBuilder,
  filePath: string,
  cacheBuster?: string,
) {
  try {
    logger.debug(`Processing file: ${filePath}`);

    // Use shared utility to load the default export, with cache busting if needed
    const importPath = cacheBuster ? `${filePath}${cacheBuster}` : filePath;
    const defaultExport = await loadModuleWithDefaultExport(importPath);

    // Verify the type of the default export
    const isRouteDefinition = (obj: unknown): obj is RouteDefinition =>
      typeof obj === "object" && obj !== null && "id" in obj;

    const isValidExport = Array.isArray(defaultExport)
      ? defaultExport.every(isRouteDefinition)
      : isRouteDefinition(defaultExport);

    if (!isValidExport) {
      logger.error(
        `Error: Default export in ${filePath} must be a RouteDefinition or array of RouteDefinitions`,
        "\nPlease ensure your route file exports a valid route configuration.",
      );
      return;
    }

    if (Array.isArray(defaultExport)) {
      defaultExport.forEach((route) => contextBuilder.routes(route));
    } else {
      contextBuilder.routes(defaultExport as RouteDefinition);
    }

    logger.info(`Successfully configured routes from ${filePath}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(`Error processing ${filePath}: ${error.message}`);
    } else {
      logger.error(`Error processing ${filePath}: An unknown error occurred`);
    }
    throw error; // Re-throw to ensure the process exits with an error code
  }
}
