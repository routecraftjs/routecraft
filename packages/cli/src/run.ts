import { resolve, extname } from "node:path";
import {
  ContextBuilder,
  type RouteDefinition,
  type CraftConfig,
  logger,
  RouteBuilder,
} from "@routecraftjs/routecraft";
import { registerContextSignalHandlers } from "./util";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".cjs"] as const;

type RunResult =
  | { success: true }
  | { success: false; code?: number; message: string };

export async function runCommand(filePath: string): Promise<RunResult> {
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

  // Enable TypeScript support if needed
  if (ext === ".ts" || ext === ".tsx") {
    try {
      // Loaded dynamically to avoid hard runtime dependency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await import("tsx/esm" as any);
    } catch {
      return {
        success: false,
        code: 1,
        message:
          "TypeScript files require the 'tsx' runtime.\nInstall it with: npm i -D tsx (or pnpm add -D tsx)",
      };
    }
  }

  try {
    logger.info(`Loading file: ${absFilePath}`);

    // Load the module with both default and named exports
    const module = await import(absFilePath);

    // Create context builder
    const contextBuilder = new ContextBuilder();

    // Check for optional craftConfig named export
    if (module.craftConfig) {
      logger.info("Found craftConfig export, applying configuration");
      contextBuilder.with(module.craftConfig as CraftConfig);
    }

    // Handle routes from the default export
    const configured = configureRoutes(contextBuilder, module.default);
    if (!configured.success) {
      return configured;
    }

    // Build and start the context
    const context = contextBuilder.build();
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
  // Type guards
  const isRouteDefinition = (obj: unknown): obj is RouteDefinition =>
    typeof obj === "object" && obj !== null && "id" in obj;

  const isRouteBuilder = (
    obj: unknown,
  ): obj is InstanceType<typeof RouteBuilder> => obj instanceof RouteBuilder;

  if (!defaultExport) {
    logger.error("No default export found. Expected routes as default export.");
    return { success: false, code: 1, message: "No default export found" };
  }

  // Handle single route or RouteBuilder
  if (isRouteDefinition(defaultExport) || isRouteBuilder(defaultExport)) {
    contextBuilder.routes(
      defaultExport as RouteDefinition | InstanceType<typeof RouteBuilder>,
    );
    logger.info("Loaded single route from default export");
    return { success: true };
  }

  // Handle array of routes
  if (Array.isArray(defaultExport)) {
    if (
      !defaultExport.every(
        (item) => isRouteDefinition(item) || isRouteBuilder(item),
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
