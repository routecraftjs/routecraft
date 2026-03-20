import { resolve, extname, basename } from "node:path";
import {
  ContextBuilder,
  type CraftConfig,
  isRouteBuilder,
  isRouteDefinition,
  logger,
  type RouteBuilder,
  type RouteDefinition,
} from "@routecraft/routecraft";
import {
  ADAPTER_CLI_ARGS,
  isCliSource,
  getCliRegistry,
} from "@routecraft/tools";
import { generateHelp, generateCommandHelp } from "./cli-help";
import { registerContextSignalHandlers } from "./util";

const SUPPORTED_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts"] as const;

type RunResult =
  | { success: true }
  | { success: false; code?: number; message: string };

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

    // Detect whether this is a CLI-mode file (any route uses cli() source)
    const definitions = collectDefinitions(module.default);
    const isCliMode = definitions.some((def) => isCliSource(def.source));

    if (isCliMode) {
      return runCliMode(
        contextBuilder,
        definitions,
        cliArgs,
        `craft run ${basename(filePath)}`,
      );
    }

    // Standard mode: build and start the context
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

/**
 * Run a CLI-mode file.
 *
 * Two-phase approach:
 * 1. Discovery: build context with no-op args so sources register metadata without firing
 * 2. Execution: build a second context with real args so the matched command fires
 *
 * ContextBuilder.build() reads but does not mutate this.definitions, so building twice is safe.
 */
async function runCliMode(
  contextBuilder: InstanceType<typeof ContextBuilder>,
  definitions: RouteDefinition[],
  cliArgs: string[],
  scriptName: string,
): Promise<RunResult> {
  // Parse: first non-flag token is the command name
  const command = cliArgs.find((a) => !a.startsWith("-"));
  const rawArgs =
    command !== undefined ? cliArgs.slice(cliArgs.indexOf(command) + 1) : [];

  // Enforce: all routes in a CLI-mode file must use cli() sources
  const nonCliRoutes = definitions.filter((def) => !isCliSource(def.source));
  if (nonCliRoutes.length > 0) {
    const ids = nonCliRoutes.map((d) => d.id).join(", ");
    return {
      success: false,
      code: 1,
      message:
        `CLI-mode files must only contain cli() source routes. ` +
        `The following routes use non-CLI sources: ${ids}. ` +
        `Remove non-CLI routes or move them to a separate file.`,
    };
  }

  // Phase 1: Discovery -- build context with undefined command so sources register and return
  const discoveryContext = await contextBuilder.build();
  discoveryContext.setStore(ADAPTER_CLI_ARGS, {
    command: undefined,
    rawArgs: [],
  });
  await discoveryContext.start();

  const registry = getCliRegistry(discoveryContext);

  // Show global help if no command given
  if (command === undefined) {
    // eslint-disable-next-line no-console
    console.log(generateHelp(scriptName, registry));
    return { success: true };
  }

  // Show per-command help on --help or -h
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const meta = registry.get(command);
    if (meta) {
      // eslint-disable-next-line no-console
      console.log(generateCommandHelp(scriptName, command, meta));
      return { success: true };
    }
  }

  // Validate command exists
  if (!registry.has(command)) {
    const available = [...registry.keys()].join(", ");
    // eslint-disable-next-line no-console
    console.error(
      `Unknown command: "${command}"\n` +
        `Available commands: ${available || "(none)"}\n\n` +
        `Run '${scriptName}' to see all commands.`,
    );
    return {
      success: false,
      code: 1,
      message: `Unknown command: "${command}"`,
    };
  }

  // Phase 2: Execution -- second build with real args; matched source fires once then aborts
  const execContext = await contextBuilder.build();
  execContext.setStore(ADAPTER_CLI_ARGS, { command, rawArgs });
  registerContextSignalHandlers(execContext);
  await execContext.start();

  return { success: true };
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

/**
 * Collect all RouteDefinitions from the default export for CLI mode detection.
 * Handles single RouteDefinition, single RouteBuilder, and arrays of either.
 */
function collectDefinitions(defaultExport: unknown): RouteDefinition[] {
  if (!defaultExport) return [];

  if (isRouteDefinition(defaultExport)) {
    return [defaultExport as RouteDefinition];
  }

  if (isRouteBuilder(defaultExport)) {
    return (
      defaultExport as RouteBuilder<unknown> & {
        build: () => RouteDefinition[];
      }
    ).build();
  }

  if (Array.isArray(defaultExport)) {
    return defaultExport.flatMap((item) => {
      if (isRouteDefinition(item)) return [item as RouteDefinition];
      if (isRouteBuilder(item)) {
        return (
          item as RouteBuilder<unknown> & {
            build: () => RouteDefinition[];
          }
        ).build();
      }
      return [];
    });
  }

  return [];
}

/**
 * Run routecraft routes as a standalone CLI application.
 *
 * Creates a context from the given routes and enters CLI mode: the first
 * non-flag token in `argv` is treated as the command name and dispatched
 * to the matching `cli()` source. Running without a command shows help.
 *
 * Use this to package a routecraft file as a named binary (e.g. `myclid`)
 * instead of requiring `craft run`.
 *
 * @param routes - Array of route definitions or route builders using `cli()` sources
 * @param options - Runner options
 * @param options.name - Binary name shown in help text (defaults to `basename(process.argv[1])`)
 * @param options.argv - CLI arguments (defaults to `process.argv.slice(2)`)
 *
 * @example
 * ```typescript
 * #!/usr/bin/env tsx
 * import { craft } from '@routecraft/routecraft';
 * import { cli } from '@routecraft/tools';
 * import { cliRunner } from '@routecraft/cli';
 * import { z } from 'zod';
 *
 * const routes = [
 *   craft().id('greet')
 *     .from(cli('greet', {
 *       schema: z.object({ name: z.string() }),
 *       description: 'Say hello',
 *     }))
 *     .transform(({ name }) => `Hello, ${name}!`)
 *     .to(cli.stdout()),
 * ];
 *
 * export default routes;
 * await cliRunner(routes, { name: 'myclid' });
 * ```
 *
 * @experimental
 */
export async function cliRunner(
  routes: Array<RouteDefinition | RouteBuilder<unknown>>,
  options?: { name?: string; argv?: string[] },
): Promise<void> {
  const cliArgs = options?.argv ?? process.argv.slice(2);
  const scriptName = options?.name ?? basename(process.argv[1] ?? "cli");

  const contextBuilder = new ContextBuilder();
  for (const route of routes) {
    contextBuilder.routes(route);
  }

  const definitions = collectDefinitions(routes);

  const result = await runCliMode(
    contextBuilder,
    definitions,
    cliArgs,
    scriptName,
  );

  if (!result.success) {
    process.exit(result.code ?? 1);
  }
}
