import { readdir, stat as fsStat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ContextBuilder, type RouteDefinition } from "@routecraft/core";
import { minimatch } from "minimatch";

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
      console.debug(`Skipping excluded file: ${path}`);
      continue;
    }

    if (file.isDirectory()) {
      yield* walkFiles(path, excludePatterns);
    } else if (file.name.endsWith(".ts")) {
      yield path;
    }
  }
}

export async function runCommand(path?: string, exclude: string[] = []) {
  const targetPath = path ? resolve(path) : process.cwd();
  const stat = await fsStat(targetPath);
  const contextBuilder = new ContextBuilder();

  if (stat.isDirectory()) {
    // Handle directory case - find all .ts files, excluding patterns
    for await (const filePath of walkFiles(targetPath, exclude)) {
      await configureRoutes(contextBuilder, filePath);
    }
  } else if (stat.isFile()) {
    // Handle single file case
    if (!targetPath.endsWith(".ts")) {
      console.error(
        "Error: Only TypeScript (.ts) files are supported at the moment",
      );
      process.exit(1);
    }

    // Check if the single file should be excluded
    const isExcluded = exclude.some((pattern) =>
      minimatch(targetPath, pattern, { matchBase: true }),
    );

    if (!isExcluded) {
      await configureRoutes(contextBuilder, targetPath);
    } else {
      console.debug(`Skipping excluded file: ${targetPath}`);
    }
  }

  const context = contextBuilder.build();

  // Add signal handlers for graceful shutdown
  const ac = new AbortController();
  const signal = ac.signal;

  addEventListener("unload", () => {
    ac.abort();
    context.stop();
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.debug(`\nReceived ${sig}, shutting down...`);
      ac.abort();
      context.stop();
      console.debug("RouteCraft stopped");
      process.exit(0);
    });
  }

  try {
    await context.start();
    // Only wait on abort if there are still active routes
    if (context.getRoutes().some((route) => !route.signal.aborted)) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("Aborted"));
        });
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message !== "Aborted") {
      console.error(error);
      process.exit(1);
    }
  }
}

async function configureRoutes(
  contextBuilder: ContextBuilder,
  filePath: string,
) {
  try {
    console.debug(`Processing file: ${filePath}`);
    const module = await import(filePath);

    if (!module.default) {
      console.warn(`Warning: No default export found in ${filePath}`);
      return;
    }

    // Verify the type of the default export
    const defaultExport = module.default;
    const isRouteDefinition = (obj: unknown): obj is RouteDefinition =>
      typeof obj === "object" && obj !== null && "id" in obj;

    const isValidExport = Array.isArray(defaultExport)
      ? defaultExport.every(isRouteDefinition)
      : isRouteDefinition(defaultExport);

    if (!isValidExport) {
      console.error(
        `Error: Default export in ${filePath} must be a RouteDefinition or array of RouteDefinitions`,
        "\nPlease ensure your route file exports a valid route configuration.",
      );
      return;
    }

    if (Array.isArray(defaultExport)) {
      defaultExport.forEach((route) => contextBuilder.routes(route));
    } else {
      contextBuilder.routes(defaultExport);
    }

    console.info(`Successfully configured routes from ${filePath}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error processing ${filePath}: ${error.message}`);
    } else {
      console.error(`Error processing ${filePath}: An unknown error occurred`);
    }
  }
}
