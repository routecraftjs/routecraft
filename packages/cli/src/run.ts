import { resolve, extname } from "node:path";
import {
  ContextBuilder,
  type CraftConfig,
  isRouteBuilder,
  isRouteDefinition,
  logger,
  shutdownHandler,
  RUNNER_ARGV,
  type AnyRouteBuilder,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { MODULE_EXTENSIONS } from "./project.js";
import { messageOf } from "./util.js";

/**
 * Result of a CLI command that boots a context. `success: false`
 * carries the message the CLI prints and the exit code it uses.
 *
 * @internal
 */
export type RunResult =
  { success: true } | { success: false; code?: number; message: string };

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

  if (!MODULE_EXTENSIONS.includes(ext)) {
    return {
      success: false,
      code: 1,
      message: `Error: Only the following file types are supported: ${MODULE_EXTENSIONS.join(", ")}`,
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
    const { context } = await contextBuilder.build();
    context.setStore(RUNNER_ARGV, cliArgs);
    shutdownHandler(context);
    await context.start();

    return { success: true };
  } catch (error: unknown) {
    const message = messageOf(error);
    logger.error(`Failed to run ${absFilePath}: ${message}`);
    return { success: false, code: 1, message };
  }
}

/**
 * Outcome of interpreting a module's default export as routes. Shared
 * by `run` (one entry file) and `start` (one capability file at a
 * time) so both accept exactly the same shapes.
 *
 * @internal
 */
export type CollectRoutesResult =
  | { ok: true; routes: (RouteDefinition | AnyRouteBuilder)[] }
  | { ok: false; reason: string };

/**
 * Interpret a module's default export as routes. Accepts a single
 * `RouteBuilder`, a single `RouteDefinition`, or an array of either.
 * Uses brand-based guards so a builder created by another copy of the
 * package still passes.
 *
 * @internal
 */
export function collectRoutes(defaultExport: unknown): CollectRoutesResult {
  if (!defaultExport) {
    return {
      ok: false,
      reason: "No default export found. Expected routes as default export.",
    };
  }
  if (isRouteBuilder(defaultExport)) {
    return { ok: true, routes: [defaultExport as AnyRouteBuilder] };
  }
  if (isRouteDefinition(defaultExport)) {
    return { ok: true, routes: [defaultExport as RouteDefinition] };
  }
  if (Array.isArray(defaultExport)) {
    if (
      !defaultExport.every(
        (item) => isRouteBuilder(item) || isRouteDefinition(item),
      )
    ) {
      return {
        ok: false,
        reason:
          "All items in the default export array must be a RouteDefinition or a RouteBuilder.",
      };
    }
    return {
      ok: true,
      routes: defaultExport as (RouteDefinition | AnyRouteBuilder)[],
    };
  }
  return {
    ok: false,
    reason:
      "Invalid default export. Expected: RouteDefinition, RouteBuilder, or array of those.",
  };
}

function configureRoutes(
  contextBuilder: InstanceType<typeof ContextBuilder>,
  defaultExport: unknown,
): RunResult {
  const collected = collectRoutes(defaultExport);
  if (!collected.ok) {
    logger.error(collected.reason);
    return { success: false, code: 1, message: collected.reason };
  }
  collected.routes.forEach((route) => contextBuilder.routes(route));
  logger.info(`Loaded ${collected.routes.length} route(s) from default export`);
  return { success: true };
}
