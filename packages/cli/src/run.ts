import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
  ContextBuilder,
  type CraftConfig,
  type Logger,
  installedPluginIds,
  isProject,
  isRouteBuilder,
  isRouteDefinition,
  defaultLogger,
  projectOf,
  rcCodeOf,
  rcError,
  shutdownHandler,
  RUNNER_INVOCATION,
  argvRouteIds,
  describeArgvRoute,
  type AnyRouteBuilder,
  type ArgvRouteHelp,
  type RouteDefinition,
  type RunnerInvocation,
  type RunnerOutcome,
} from "@routecraft/routecraft";
import { MODULE_EXTENSIONS, displayPath, findConfigFile } from "./project.js";
import { messageOf } from "./util.js";
import { dispatchResult, EXEC_EXIT, type ExecResult } from "./exec.js";
import { renderArgvHelp, renderArgvRoutes, renderRefusal } from "./format.js";
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
 * Result of `craft run`. A file with an `argv()` route answers in `reply`,
 * rendered and with its exit code, and the caller exits with that code.
 *
 * @internal
 */
export type RunResult = CommandOutcome | { reply: ExecResult };

/** The flags `craft run` reads itself after the file; never route input. */
const RUN_FLAGS: readonly string[] = ["help", "format"];

/** The reserved flag names a route's `.input()` body declares as fields. */
function reservedCollisions(help: ArgvRouteHelp): string[] {
  const properties = (help.input as { properties?: unknown } | undefined)
    ?.properties;
  if (properties === null || typeof properties !== "object") return [];
  return RUN_FLAGS.filter((name) => Object.hasOwn(properties, name));
}

/** What `craft run` needs beyond the file and its arguments. */
export interface RunOptions extends Pick<
  SettingsOverrides,
  "profile" | "cwd" | "env" | "home"
> {
  /** Reads piped stdin; only called when an `argv()` route needs input. */
  readStdin?: () => Promise<string | undefined>;
  /**
   * `--config <path>`: the project file to run the routes in. `false`
   * (`--no-config`) skips the `craft.config` beside the nearest
   * `package.json`.
   */
  config?: string | false;
}

/**
 * Load a routecraft file, build a context, and start it.
 *
 * The file runs in a project, the first of these that exists: the one
 * `--config` names; the file's own `export const project`; the
 * `craft.config` beside the nearest `package.json`, when it installs every
 * plugin of the project the routes were built with; that project itself;
 * the defaults.
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

  let log: Logger | undefined;
  try {
    const module = (await import(absFilePath)) as {
      default?: unknown;
      project?: unknown;
      craftConfig?: unknown;
    };
    const project = await runProject(absFilePath, module, options.config);

    // The project's own logger takes the run's lines when it has one; the default logger otherwise.
    log = project.config?.logger ?? defaultLogger();
    log.info({ file: absFilePath, project: project.from }, "Loading file");
    for (const note of project.notes) log.warn(note);

    const contextBuilder = new ContextBuilder();
    if (project.config) contextBuilder.with(project.config);

    const configured = configureRoutes(contextBuilder, module.default, log);
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
    // build() already bound the plugins, so a run that never starts still stops.
    const line = runnerLine(cliArgs, readers, options);
    if ("error" in line) {
      await context.stop();
      return { success: false, code: EXEC_EXIT.usage, message: line.error };
    }
    const chosen = beforeStart(context, readers, line);
    if ("answer" in chosen) {
      await context.stop();
      return chosen.answer;
    }
    const { routeId } = chosen;

    let settled: RunnerOutcome | undefined;
    const answered = Promise.withResolvers<RunnerOutcome>();
    const invocation: RunnerInvocation = {
      routeId,
      argv: line.argv,
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
    await context.stop();
    await started.catch(() => undefined);
    const outcome = first ?? settled;
    if (outcome === undefined) {
      // A disabled route, or one that failed to start, never subscribes.
      return {
        reply: {
          code: EXEC_EXIT.failed,
          error: `Route "${routeId}" never read the command line: it is disabled or did not start. The log says why.`,
        },
      };
    }
    return { reply: renderOutcome(outcome, routeId, line.format) };
  } catch (error: unknown) {
    const code = rcCodeOf(error);
    const message = `${code === undefined ? "" : `${code}: `}${messageOf(error)}`;
    (log ?? defaultLogger()).error(`Failed to run ${absFilePath}: ${message}`);
    return { success: false, code: 1, message };
  }
}

/** The project a single file runs in, and where it came from. */
interface RunProject {
  config?: CraftConfig;
  /** Where the project was found, for the log. */
  from: string;
  /** What the reader should know about a project that was passed over. */
  notes: string[];
}

/**
 * Choose the project a file's routes run in. First match wins.
 *
 * @throws RC1120 when a project file that is read does not default-export a
 *   project, or the file itself still exports a lone `craftConfig`
 * @throws when the file's routes were built with more than one project
 */
async function runProject(
  file: string,
  module: { default?: unknown; project?: unknown; craftConfig?: unknown },
  flag: string | false | undefined,
): Promise<RunProject> {
  const { loadConfig } = await import("./start.js");
  const read = async (path: string): Promise<CraftConfig> => {
    try {
      return await loadConfig(path);
    } catch (error: unknown) {
      if (rcCodeOf(error) !== "RC1120") throw error;
      throw rcError("RC1120", error, {
        message: `${displayPath(process.cwd(), path)}: ${messageOf(error)}`,
      });
    }
  };

  if (typeof flag === "string") {
    const path = resolve(process.cwd(), flag);
    return { config: await read(path), from: `--config ${path}`, notes: [] };
  }
  if (isProject(module.project)) {
    return {
      config: module.project.config,
      from: "the file's project export",
      notes: [],
    };
  }
  if (module.project !== undefined) {
    throw rcError("RC1120", undefined, {
      message: `${file} exports project, but it is not a project. Write \`export const project = defineProject({ ... })\`.`,
    });
  }
  if (module.craftConfig !== undefined) {
    throw rcError("RC1120", undefined, {
      message: `${file} exports craftConfig, the pre-0.8 shape, which is no longer read. Write \`export const project = defineProject({ ... })\` with the same keys, and build the routes with project.craft().`,
    });
  }

  const exported = Array.isArray(module.default)
    ? module.default
    : [module.default];
  const own = [...new Set(exported.flatMap((route) => projectOf(route) ?? []))];
  if (own.length > 1) {
    throw new Error(
      `The routes in ${file} were built with ${own.length} different projects, and one run has one. Name the project to run them in with --config <path>.`,
    );
  }
  const routesProject = own[0];
  const notes: string[] = [];

  const beside = flag === false ? undefined : nearestConfigFile(dirname(file));
  if (beside !== undefined) {
    const shown = displayPath(process.cwd(), beside);
    const fallback =
      "Running with the routes' own project; pass --config to choose another.";
    let config: CraftConfig | undefined;
    try {
      config = await read(beside);
    } catch (error: unknown) {
      if (routesProject === undefined) throw error;
      notes.push(`Ignoring ${shown}: ${messageOf(error)} ${fallback}`);
    }
    if (config !== undefined) {
      const missing = routesProject
        ? missingPlugins(config, routesProject.config)
        : [];
      if (missing.length === 0) return { config, from: beside, notes };
      notes.push(
        `Ignoring ${shown}: it does not install ${missing.map((id) => `"${id}"`).join(", ")}, which the project these routes were built with does. ${fallback}`,
      );
    }
  }
  if (routesProject !== undefined) {
    return {
      config: routesProject.config,
      from: "the routes' own project",
      notes,
    };
  }
  return { from: "the defaults", notes };
}

/** The plugin ids `needed` installs that `config` does not. */
function missingPlugins(config: CraftConfig, needed: CraftConfig): string[] {
  const installed = new Set(installedPluginIds(config));
  return [...new Set(installedPluginIds(needed))].filter(
    (id) => !installed.has(id),
  );
}

/** The `craft.config` beside the nearest `package.json` at or above `from`. */
function nearestConfigFile(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return findConfigFile(dir);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Pick the `argv()` route this invocation runs, or give the answer
 * `craft run` owes without starting the context: `--help`, a route name
 * that is missing or unknown, or a route field named like a runner flag.
 * With one `argv()` route the name is optional.
 */
function beforeStart(
  context: Parameters<typeof argvRouteIds>[0],
  readers: readonly string[],
  line: RunnerLine,
): { routeId: string } | { answer: RunResult } {
  const usage = (message: string): { answer: RunResult } => ({
    answer: { success: false, code: EXEC_EXIT.usage, message },
  });
  const printed = (output: string): { answer: RunResult } => ({
    answer: { reply: { code: EXEC_EXIT.ok, output } },
  });
  const describe = (id: string): ArgvRouteHelp =>
    describeArgvRoute(context, id) ?? { id };
  const listed = readers.map((id) => `"${id}"`).join(", ");

  if (line.route !== undefined && !readers.includes(line.route)) {
    return usage(
      `"${line.route}" is not a route that reads the command line with argv() (those are ${listed}). Route input is passed as --field=value pairs, or as JSON on stdin.`,
    );
  }
  const routeId = line.route ?? (readers.length === 1 ? readers[0] : undefined);
  if (routeId === undefined) {
    if (line.help) {
      return printed(renderArgvRoutes(readers.map(describe), line.format));
    }
    return usage(
      `Routes ${listed} all read the command line with argv(). Name the one to run: craft run <file> <route> [--field=value ...]`,
    );
  }
  const help = describe(routeId);
  const collisions = reservedCollisions(help);
  if (collisions.length > 0) {
    return usage(
      `Route "${routeId}" declares the input field(s) ${collisions.map((name) => `"${name}"`).join(", ")}, which craft run reads itself (${collisions.map((name) => `--${name}`).join(", ")}). Rename the field.`,
    );
  }
  if (line.help) return printed(renderArgvHelp(help, line.format));
  return { routeId };
}

/**
 * The command line as the runner reads it: `--help` and `--format` taken
 * out for the runner, a leading argument that is a route id or not a flag
 * as the route to run,
 * everything else left for the route, and the default format from the
 * settings file.
 */
interface RunnerLine {
  argv: string[];
  route?: string;
  help: boolean;
  format: OutputFormat;
}

function runnerLine(
  cliArgs: readonly string[],
  readers: readonly string[],
  overrides: Pick<SettingsOverrides, "profile" | "cwd" | "env" | "home">,
): RunnerLine | { error: string } {
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
      ...overrides,
      ...(flagged === undefined ? {} : { format: flagged }),
    });
    const first = argv[0];
    const named =
      first !== undefined &&
      (readers.includes(first) || !first.startsWith("-"));
    return {
      argv: named ? argv.slice(1) : argv,
      ...(named ? { route: first } : {}),
      help,
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
  routeId: string,
  format: OutputFormat,
): ExecResult {
  switch (outcome.outcome) {
    case "completed":
    case "deferred":
    case "dropped":
      return dispatchResult(outcome, format);
    case "usage":
      return {
        code: EXEC_EXIT.usage,
        error: `${outcome.message}\nSee the route's input with: craft run <file> ${routeId} --help`,
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
  log: Logger,
): CommandOutcome {
  const collected = collectRoutes(defaultExport);
  if (!collected.ok) {
    log.error(collected.reason);
    return { success: false, code: 1, message: collected.reason };
  }
  collected.routes.forEach((route) => contextBuilder.routes(route));
  log.info(
    { routes: collected.routes.length },
    "Loaded routes from default export",
  );
  return { success: true };
}
