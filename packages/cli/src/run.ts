import { resolve, extname } from "node:path";
import {
  ContextBuilder,
  type RouteDefinition,
  type CraftConfig,
  configureLogger,
  logger,
  RouteBuilder,
} from "@routecraft/routecraft";
import { registerContextSignalHandlers } from "./util";

const SUPPORTED_EXTENSIONS = [".mjs", ".js", ".cjs"] as const;

type RunResult =
  | { success: true }
  | { success: false; code?: number; message: string };

export async function runCommand(filePath: string): Promise<RunResult> {
  const absFilePath = resolve(process.cwd(), filePath);
  const ext = extname(absFilePath);

  // Reject TypeScript files explicitly (before generic extension check)
  if (ext === ".ts" || ext === ".tsx") {
    return {
      success: false,
      code: 1,
      message:
        "TypeScript files are not supported by 'craft run'. Compile to .js or use .mjs/.js/.cjs.",
    };
  }

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
    // Load the module first so we can read craftConfig and set up logging before any logger use.
    const module = await import(absFilePath);
    const craftConfig = module.craftConfig as CraftConfig | undefined;

    // Merge log options: CLI env over craft config over defaults, then configure once.
    const logFile =
      process.env["LOG_FILE"] ??
      process.env["CRAFT_LOG_FILE"] ??
      craftConfig?.log?.file;
    const mergedLog: Parameters<typeof configureLogger>[0] = {
      level:
        process.env["LOG_LEVEL"] ??
        process.env["CRAFT_LOG_LEVEL"] ??
        craftConfig?.log?.level ??
        "warn",
      ...(logFile !== undefined && { logFile }),
      ...(craftConfig?.log?.redact !== undefined && {
        redact: craftConfig.log.redact,
      }),
    };
    configureLogger(mergedLog);

    logger.info(`Loading file: ${absFilePath}`);

    // Create context builder
    const contextBuilder = new ContextBuilder();

    // Apply craftConfig (routes, plugins, etc.); log was already applied above.
    if (craftConfig) {
      logger.info("Found craftConfig export, applying configuration");
      contextBuilder.with(craftConfig);
    }

    // Handle routes from the default export
    const configured = configureRoutes(contextBuilder, module.default);
    if (!configured.success) {
      return configured;
    }

    // Build and start the context
    const context = await contextBuilder.build();
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
  // Type guards (duck-typing so routes from user file's routecraft are accepted)
  const isRouteBuilder = (
    obj: unknown,
  ): obj is InstanceType<typeof RouteBuilder> =>
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { build?: unknown }).build === "function";

  const isRouteDefinition = (obj: unknown): obj is RouteDefinition =>
    typeof obj === "object" &&
    obj !== null &&
    "id" in obj &&
    typeof obj.id === "string" && // Ensure id is a string, not a method
    "source" in obj &&
    "steps" in obj &&
    "consumer" in obj;

  if (!defaultExport) {
    logger.error("No default export found. Expected routes as default export.");
    return { success: false, code: 1, message: "No default export found" };
  }

  // Handle single RouteBuilder or RouteDefinition
  // Check RouteBuilder first since it also has an 'id' property (as a method)
  if (isRouteBuilder(defaultExport)) {
    contextBuilder.routes(defaultExport);
    logger.info("Loaded single RouteBuilder from default export");
    return { success: true };
  }

  if (isRouteDefinition(defaultExport)) {
    contextBuilder.routes(defaultExport);
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
        routeOrBuilder as RouteDefinition | InstanceType<typeof RouteBuilder>,
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
