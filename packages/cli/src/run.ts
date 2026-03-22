import { resolve, extname } from "node:path";
import {
  ContextBuilder,
  type CraftConfig,
  isRouteBuilder,
  isRouteDefinition,
  logger,
  RUNNER_ARGV,
  type RouteBuilder,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { registerContextSignalHandlers } from "./util";

const SUPPORTED_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts"] as const;

type RunResult =
  | { success: true }
  | { success: false; code?: number; message: string };

/**
 * Load a routecraft file, build a context, and start it.
 *
 * Adapter-agnostic: the runner knows nothing about which adapters (CLI, HTTP,
 * cron, etc.) are used. It sets `RUNNER_ARGV` in the context store so that
 * adapters can read remaining CLI tokens if needed.
 *
 * @param filePath - Path to the routecraft file to run
 * @param cliArgs - Remaining CLI arguments after the file path
 */
export async function runCommand(
  filePath: string,
  cliArgs: string[] = [],
): Promise<RunResult> {
  const absFilePath = resolve(process.cwd(), filePath);
  const ext = extname(absFilePath);

  // Validate file extension
  if (
    !SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])
  ) {
    return {
      success: false,
      code: 1,
      message: `Error: Only the following file types are supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    };
  }

  try {
    // Load the module (CLI already set LOG_LEVEL / LOG_FILE from argv in index.ts).
    // Logger uses env first; context will apply craftConfig.log when built (env wins if set).
    const module = await import(absFilePath);
    const craftConfig = module.craftConfig as CraftConfig | undefined;

    logger.info(`Loading file: ${absFilePath}`);

    // Create context builder
    const contextBuilder = new ContextBuilder();

    // Apply craftConfig (routes, plugins, etc.); context applies config.log when built.
    if (craftConfig) {
      logger.info("Found craftConfig export, applying configuration");
      contextBuilder.with(craftConfig);
    }

    // Handle routes from the default export
    const configured = configureRoutes(contextBuilder, module.default);
    if (!configured.success) {
      return configured;
    }

    // Build and start the context. Adapters handle their own lifecycle.
    // RUNNER_ARGV lets adapters (e.g. CLI) read remaining args without
    // the runner needing to know which adapters are in use.
    const context = await contextBuilder.build();
    context.setStore(RUNNER_ARGV, cliArgs);
    registerContextSignalHandlers(context);
    await context.start();

    return { success: true };
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(`Failed to run ${absFilePath}: ${error.message}`);
      return { success: false, code: 1, message: error.message };
    }
    logger.error(`Failed to run ${absFilePath}: Unknown error occurred`);
    return { success: false, code: 1, message: "Unknown error" };
  }
}

function configureRoutes(
  contextBuilder: InstanceType<typeof ContextBuilder>,
  defaultExport: unknown,
): RunResult {
  if (!defaultExport) {
    logger.error("No default export found. Expected routes as default export.");
    return { success: false, code: 1, message: "No default export found" };
  }

  // Handle single RouteBuilder or RouteDefinition (brand-based guards for cross-instance)
  if (isRouteBuilder(defaultExport)) {
    contextBuilder.routes(defaultExport as RouteBuilder<unknown>);
    logger.info("Loaded single RouteBuilder from default export");
    return { success: true };
  }

  if (isRouteDefinition(defaultExport)) {
    contextBuilder.routes(defaultExport as RouteDefinition);
    logger.info("Loaded single route from default export");
    return { success: true };
  }

  // Handle array of routes
  if (Array.isArray(defaultExport)) {
    // Check each item, prioritizing RouteBuilder check
    if (
      !defaultExport.every(
        (item) => isRouteBuilder(item) || isRouteDefinition(item),
      )
    ) {
      logger.error(
        "All items in default export array must be RouteDefinition or RouteBuilder",
      );
      return {
        success: false,
        code: 1,
        message: "Invalid items in default export array",
      };
    }

    defaultExport.forEach((routeOrBuilder) =>
      contextBuilder.routes(
        routeOrBuilder as RouteDefinition | RouteBuilder<unknown>,
      ),
    );
    logger.info(
      `Loaded ${defaultExport.length} routes from default export array`,
    );
    return { success: true };
  }

  // Invalid default export
  logger.error(
    "Invalid default export. Expected: RouteDefinition, RouteBuilder, or array of those.",
  );
  return {
    success: false,
    code: 1,
    message:
      "Invalid default export. Expected: RouteDefinition, RouteBuilder, or array of those.",
  };
}
