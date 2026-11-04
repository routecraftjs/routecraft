import { resolve, extname } from "node:path";
import {
  ContextBuilder,
  type CraftConfig,
  isRouteBuilder,
  isRouteDefinition,
  logger,
  shutdownHandler,
  RUNNER_INVOCATION,
  argvRouteIds,
  type AnyRouteBuilder,
  type RouteDefinition,
  type RunnerInvocation,
  type RunnerOutcome,
} from "@routecraft/routecraft";
import { MODULE_EXTENSIONS } from "./project.js";
import { messageOf } from "./util.js";
import { dispatchResult, EXEC_EXIT, type ExecResult } from "./exec.js";
import { renderArgvHelp, renderRefusal } from "./format.js";
import {
  resolveSettings,
  SettingsError,
  type OutputFormat,
  type SettingsOverrides,
} from "./settings.js";

/**
 * Result of a CLI command that boots a context. `success: false`
 * carries the message the CLI prints and the exit code it uses.
 *
 * @internal
 */
export type CommandOutcome =
  { success: true } | { success: false; code?: number; message: string };

/**
 * Result of `craft run`. A file that answered its command line through
 * `argv()` carries that answer in `reply`, rendered and with its exit code;
 * `success` is whether that code is 0.
 *
 * @internal
 */
export type RunResult =
  CommandOutcome | { success: boolean; reply: ExecResult };

/** The flags `craft run` reads itself after the file; never route input. */
const RUN_FLAGS: readonly string[] = ["help", "format"];

/** What `craft run` needs beyond the file and its arguments. */
export interface RunOptions extends Pick<
  SettingsOverrides,
  "profile" | "cwd" | "env" | "home"
> {
  /** Reads piped stdin; only called when an `argv()` route needs input. */
  readStdin?: () => Promise<string | undefined>;
}

/**
 * Load a routecraft file, build a context, and start it.
 *
 * Adapter-agnostic: the runner hands the command line to the context under
 * `RUNNER_INVOCATION` and knows nothing about which route reads it. When a
 * route's `argv()` source settles the invocation, the runner stops the
 * context, because a route that also has `direct()` or `mcp()` would
 * otherwise hold the process open, and returns the rendered answer.
 *
 * @param filePath - Path to the routecraft file to run
 * @param cliArgs - Remaining CLI arguments after the file path
 * @param options - Settings overrides and the stdin reader
 */
export async function runCommand(
  filePath: string,
  cliArgs: string[] = [],
  options: RunOptions = {},
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

    const contextBuilder = new ContextBuilder();
    if (craftConfig) {
      logger.info("Found craftConfig export, applying configuration");
      contextBuilder.with(craftConfig);
    }

    const configured = configureRoutes(contextBuilder, module.default);
    if (!configured.success) {
      return configured;
    }

    const { context } = await contextBuilder.build();
    shutdownHandler(context);

    const readers = argvRouteIds(context);
    if (readers.length === 0) {
      await context.start();
      return { success: true };
    }
    if (readers.length > 1) {
      return {
        success: false,
        code: EXEC_EXIT.usage,
        message: `Routes ${readers.map((id) => `"${id}"`).join(", ")} all read the command line with argv(). One invocation runs one route; keep argv() on one of them.`,
      };
    }

    const line = runnerLine(cliArgs, options);
    if ("error" in line) {
      return { success: false, code: EXEC_EXIT.usage, message: line.error };
    }
    let settled: RunnerOutcome | undefined;
    const answered = Promise.withResolvers<RunnerOutcome>();
    const invocation: RunnerInvocation = {
      argv: line.argv,
      help: line.help,
      reserved: RUN_FLAGS,
      scopes: line.scopes,
      readStdin: options.readStdin ?? (() => Promise.resolve(undefined)),
      settle(outcome) {
        if (settled !== undefined) return;
        settled = outcome;
        answered.resolve(outcome);
      },
    };
    context.setStore(RUNNER_INVOCATION, invocation);

    // Raced rather than awaited: `context.start()` never resolves while a
    // server ingress beside `argv()` holds the route open.
    const started = context.start();
    const first = await Promise.race([
      answered.promise,
      started.then(() => undefined),
    ]);
    const outcome = first ?? settled;
    if (outcome === undefined) {
      await started;
      return { success: true };
    }
    await context.stop();
    await started.catch(() => undefined);
    const reply = renderOutcome(outcome, line.format);
    return { success: reply.code === EXEC_EXIT.ok, reply };
  } catch (error: unknown) {
    const message = messageOf(error);
    logger.error(`Failed to run ${absFilePath}: ${message}`);
    return { success: false, code: 1, message };
  }
}

/**
 * The command line as the runner reads it: `--help` and `--format` taken
 * out for the runner, everything else left for the route, and the
 * operator's scopes and default format from the settings file.
 */
function runnerLine(
  cliArgs: readonly string[],
  options: RunOptions,
):
  | { argv: string[]; help: boolean; scopes: string[]; format: OutputFormat }
  | { error: string } {
  const argv: string[] = [];
  let help = false;
  let flagged: string | undefined;
  for (let index = 0; index < cliArgs.length; index++) {
    const arg = cliArgs[index]!;
    if (arg === "--help") {
      help = true;
    } else if (arg.startsWith("--format=")) {
      flagged = arg.slice("--format=".length);
    } else if (arg === "--format") {
      const next = cliArgs[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return {
          error: "--format needs a value: pretty, json, or raw.",
        };
      }
      flagged = next;
      index += 1;
    } else {
      argv.push(arg);
    }
  }
  try {
    const settings = resolveSettings({
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(flagged === undefined ? {} : { format: flagged }),
    });
    return {
      argv,
      help,
      scopes: settings.scopes?.value ?? [],
      format: settings.format.value,
    };
  } catch (error: unknown) {
    if (error instanceof SettingsError) return { error: error.message };
    throw error;
  }
}

/**
 * The answer to print and the exit code, the same codes `craft exec` uses:
 * a deferral is an outcome rather than a fault, a drop is not a result, and
 * a refusal of who the caller is differs from a refusal of what it sent.
 */
function renderOutcome(
  outcome: RunnerOutcome,
  format: OutputFormat,
): ExecResult {
  switch (outcome.outcome) {
    case "completed":
    case "deferred":
    case "dropped":
      return dispatchResult(outcome, format);
    case "help":
      return {
        code: EXEC_EXIT.ok,
        output: renderArgvHelp(outcome.route, format),
      };
    case "usage":
      return {
        code: EXEC_EXIT.usage,
        error: `${outcome.message}\nSee the route's input with: craft run <file> --help`,
      };
    case "refused": {
      const { refusal } = outcome;
      const invalid =
        refusal.kind === "input" ||
        (refusal.kind === "refused" && refusal.as === "invalid");
      return {
        code: invalid ? EXEC_EXIT.usage : EXEC_EXIT.refused,
        error: renderRefusal(refusal),
      };
    }
    case "failed":
      return { code: EXEC_EXIT.failed, error: outcome.message };
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
    return { ok: true, routes: [defaultExport] };
  }
  if (isRouteDefinition(defaultExport)) {
    return { ok: true, routes: [defaultExport] };
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
): CommandOutcome {
  const collected = collectRoutes(defaultExport);
  if (!collected.ok) {
    logger.error(collected.reason);
    return { success: false, code: 1, message: collected.reason };
  }
  collected.routes.forEach((route) => contextBuilder.routes(route));
  logger.info(`Loaded ${collected.routes.length} route(s) from default export`);
  return { success: true };
}
