#!/usr/bin/env bun

/**
 * Routecraft CLI: single entry point.
 *
 * The CLI runs on Bun. For Node-based usage, embed @routecraft/routecraft
 * programmatically (see https://routecraft.dev/docs/advanced/programmatic-invocation).
 *
 * 1. Bun runtime gate (presence + version floor)
 * 2. Define program and parse; log options are global and applied before
 *    lazy-loading run/util (which load the logger)
 */

import { checkBunRuntime } from "./runtime-gate.js";
import { version } from "../package.json";

// ── 1. Bun runtime gate ─────────────────────────────────────────────
const gate = checkBunRuntime();
if (!gate.ok) {
  // eslint-disable-next-line no-console
  console.error(gate.message);
  process.exit(1);
}

// ── 2. CLI definition (only Commander; run/util are lazy-loaded so logger sees env) ─
const { Command } = await import("commander");
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version(version)
  .enablePositionalOptions()
  .option(
    "--log-level <level>",
    "Log level (e.g. info, warn, error, silent to disable)",
  )
  .option("--log-file <path>", "Write logs to a file instead of stdout")
  .showSuggestionAfterError()
  .showHelpAfterError()
  .exitOverride((err) => {
    if (err.code === "commander.unknownCommand") {
      process.exit(0);
    }
  });

// Show help by default if no arguments provided
if (process.argv.length <= 2) {
  program.help({ error: false });
}

/**
 * Push the global log options onto the environment before any import
 * that constructs the logger. The logger reads env at module load, so
 * this has to happen inside a command action but ahead of the lazy
 * `run` / `start` imports.
 */
function applyGlobalLogOptions(local: LogOptions = {}): void {
  const globalOpts = program.opts();
  // The command's own flag wins, so `craft --log-level warn start --log-level
  // debug` reads the way a reader expects: the nearer one.
  const level = local.logLevel ?? globalOpts["logLevel"];
  const file = local.logFile ?? globalOpts["logFile"];
  if (level !== undefined) {
    process.env["LOG_LEVEL"] = level;
    process.env["CRAFT_LOG_LEVEL"] = level;
  }
  if (file !== undefined) {
    process.env["LOG_FILE"] = file;
    process.env["CRAFT_LOG_FILE"] = file;
  }
}

/**
 * The logging flags a command may carry as well as the program.
 *
 * `enablePositionalOptions()` confines a global option to the space before
 * the subcommand, so `craft start --log-level info` died on "unknown
 * option" and `craft run app.ts --log-level info` was swallowed whole by the
 * pass-through and handed to the route. That is the spelling everyone
 * reaches for, and the rule bought nothing here but a lesson every user had
 * to learn once.
 *
 * `run` keeps its pass-through contract: a flag written after the file still
 * belongs to the route, because that is the only way a CLI-adapter route can
 * own a flag the CLI also defines.
 */
interface LogOptions {
  logLevel?: string;
  logFile?: string;
}

type CommanderCommand = InstanceType<typeof Command>;

/** Attach the logging flags to a command that boots a context. */
function withLogOptions(command: CommanderCommand): CommanderCommand {
  return command
    .option(
      "--log-level <level>",
      "Log level (e.g. info, warn, error, silent to disable)",
    )
    .option("--log-file <path>", "Write logs to a file instead of stdout");
}

/**
 * Resolve the selected profile and load the environment it names, before
 * anything imports the project's configuration.
 *
 * Ordering is the whole point: a config file reads `process.env` at module
 * scope, so the environment has to be in place before the import, and the
 * profile is what says which environment that is.
 *
 * A settings file that cannot be used stops the command rather than
 * falling back to the defaults, because an operator who wrote a profile
 * and silently got the loopback default would have no way to tell.
 */
async function selectEnvironment(
  options: { env?: string; profile?: string },
  projectRoot: string,
): Promise<{ error?: string }> {
  const { loadEnvironment } = await import("./util.js");
  const { resolveSettings, SettingsError } = await import("./settings.js");
  try {
    // Resolved under the project root, not the shell's directory: the file
    // that declares a profile and the env files that profile selects have
    // to be the same project's, or `craft start ./apps/eywa` reads one
    // project's profile and another's environment.
    const settings = resolveSettings({
      cwd: projectRoot,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
    loadEnvironment({
      explicit: options.env,
      profile: settings.profile?.value,
      env: settings.env?.value,
      defaultsFrom: projectRoot,
    });
    return {};
  } catch (error: unknown) {
    if (error instanceof SettingsError) return { error: error.message };
    throw error;
  }
}

/**
 * The 'run' command executes routes from a single file.
 *
 * Example:
 * craft run ./my-routes.ts
 * craft run ./my-cli.ts greet --name World
 */
withLogOptions(
  program
    .command("run")
    .description("Run routes from a single TypeScript/JavaScript file")
    .argument("<file>", "Path to a file containing routes")
    .argument(
      "[args...]",
      "CLI command and flags to pass through to CLI adapter routes",
    )
    .option(
      "--env <path>",
      "Load environment variables from a .env file (default: .env)",
    )
    .option("--profile <name>", "Settings profile to select"),
)
  .passThroughOptions()
  .action(async (filePath, args: string[], options) => {
    applyGlobalLogOptions(options as LogOptions);

    const selected = await selectEnvironment(options, process.cwd());
    if (selected.error !== undefined) {
      settle({ code: 2, error: selected.error });
      return;
    }

    const { runCommand } = await import("./run.js");
    const result = await runCommand(filePath, args);
    if (!result.success) {
      if (result.message) {
        // eslint-disable-next-line no-console
        console.error(result.message);
      }
      // Defer exit so pino/sonic-boom can finish initializing and avoid "sonic boom is not ready yet"
      const code = result.code ?? 1;
      setImmediate(() => process.exit(code));
      return;
    }
    // Don't call process.exit(); let the event loop drain naturally.
    // process.exit() triggers C++ static destructors that race with ONNX
    // Runtime cleanup (onnxruntime#25038: "mutex lock failed").
  });

/**
 * The 'start' command boots a whole project from the folder convention.
 *
 * Example:
 * craft start
 * craft start ./apps/eywa --once
 */
withLogOptions(
  program
    .command("start")
    .description(
      "Start a project from its folder convention (capabilities, plugins, agents, skills)",
    )
    .argument("[dir]", "Project root (default: current directory)")
    .option(
      "--env <path>",
      "Load environment variables from a .env file (default: .env)",
    )
    .option(
      "--once",
      "Shut down after the first exchange reaches a terminal outcome",
    )
    .option(
      "--timeout <duration>",
      'With --once, give up and exit non-zero after this long (milliseconds, or a duration string like "30s")',
    )
    .option("--profile <name>", "Settings profile to select"),
).action(
  async (
    dir: string | undefined,
    options: {
      env?: string;
      once?: boolean;
      timeout?: string;
      profile?: string;
    } & LogOptions,
  ) => {
    applyGlobalLogOptions(options);

    const { resolve: resolvePath } = await import("node:path");
    const projectRoot = resolvePath(process.cwd(), dir ?? ".");

    // The conventional files belong to the project being started, not to
    // whatever directory the shell happens to sit in. Resolved and
    // loaded before `craft.config.ts` is imported, because config files
    // read `process.env` at module scope.
    const selected = await selectEnvironment(options, projectRoot);
    if (selected.error !== undefined) {
      settle({ code: 2, error: selected.error });
      return;
    }

    const { startCommand } = await import("./start.js");
    // A bare number stays milliseconds, so every existing invocation keeps
    // working; anything else goes through the framework's duration grammar
    // so `--timeout 30s` means what it reads as.
    let timeoutMs: number | undefined;
    if (options.timeout !== undefined) {
      const { parseDuration } = await import("@routecraft/routecraft");
      const raw = /^\d+(\.\d+)?$/.test(options.timeout.trim())
        ? Number(options.timeout)
        : (options.timeout as `${number}s`);
      try {
        timeoutMs = parseDuration(raw, "--timeout");
      } catch {
        // eslint-disable-next-line no-console
        console.error(
          `--timeout must be a number of milliseconds (at least 1) or a duration string like "30s". Received "${String(options.timeout)}".`,
        );
        setImmediate(() => process.exit(1));
        return;
      }
    }
    if (timeoutMs !== undefined && options.once !== true) {
      // eslint-disable-next-line no-console
      console.error(
        `--timeout bounds the wait for the first exchange, which only --once waits for. Add --once, or drop --timeout.`,
      );
      setImmediate(() => process.exit(1));
      return;
    }
    const result = await startCommand(dir, {
      once: options.once === true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (!result.success) {
      if (result.message) {
        // eslint-disable-next-line no-console
        console.error(result.message);
      }
      // Defer exit so pino/sonic-boom can finish initializing and avoid
      // "sonic boom is not ready yet"
      const code = result.code ?? 1;
      setImmediate(() => process.exit(code));
      return;
    }
    // Don't call process.exit(); let the event loop drain naturally.
  },
);

/**
 * Print a command's result and exit with its code.
 *
 * The write is awaited rather than fired and forgotten. `process.stdout` is
 * asynchronous when it is a pipe, and `process.exit` discards whatever is
 * still queued, so `craft exec --format json | jq` would lose the tail of a
 * large result. Exiting from the write callback is what makes the payload
 * whole; the exit itself stays deferred so pino/sonic-boom can finish
 * initialising, the same reason `run` and `start` defer theirs.
 */
function settle(result: {
  code: number;
  output?: string;
  error?: string;
}): void {
  const writes: Array<[NodeJS.WriteStream, string]> = [];
  if (result.output !== undefined) writes.push([process.stdout, result.output]);
  if (result.error !== undefined) writes.push([process.stderr, result.error]);

  const finish = (): void => {
    setImmediate(() => process.exit(result.code));
  };
  if (writes.length === 0) {
    finish();
    return;
  }
  // Set early so a stream that never drains still exits with the right code
  // rather than reporting success on the way out.
  process.exitCode = result.code;
  let pending = writes.length;
  for (const [stream, text] of writes) {
    stream.write(`${text}\n`, () => {
      pending -= 1;
      if (pending === 0) finish();
    });
  }
}

/**
 * Read route input piped on stdin, or undefined when none was.
 *
 * Gated on stdin actually being a redirect (a pipe or a file) rather than
 * on it not being a TTY. The two are not the same: a process launched by
 * CI, a supervisor, or another program routinely inherits a socket on fd 0
 * that is neither a terminal nor ever going to close, and reading it waits
 * for an EOF that never comes. `craft exec` would hang with no output,
 * which is the worst way to fail.
 */
async function readStdin(): Promise<string | undefined> {
  const { fstatSync } = await import("node:fs");
  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : text;
}

/**
 * The 'exec' command dispatches to a route on a running instance.
 *
 * Craft's own flags come before the route name and the route's input comes
 * after it, the same split `craft run` uses, so a route field can never
 * collide with a CLI flag.
 *
 * Example:
 * craft exec greet --name World
 * craft exec --url http://10.0.0.5:8080 --token "$TOKEN" greet --name World
 */
program
  .command("exec")
  .description("Dispatch to a route on a running instance and print the result")
  .argument("[route]", "Route id to dispatch to; omit for the endpoint list")
  .argument("[args...]", "Route input as --field=value pairs")
  .option("--profile <name>", "Settings profile to select")
  .option("--url <url>", "Ops server base URL of the target instance")
  .option("--token <token>", "Bearer credential for the management door")
  .option("--format <format>", "pretty (default), json, or raw")
  .passThroughOptions()
  .allowUnknownOption()
  .action(
    async (
      route: string | undefined,
      args: string[],
      options: {
        profile?: string;
        url?: string;
        token?: string;
        format?: string;
      },
    ) => {
      applyGlobalLogOptions();
      const { execCommand } = await import("./exec.js");
      // Args and stdin are mutually exclusive, so a command that already
      // carries args must not read stdin at all: in `tail -f x | while read
      // l; do craft exec r --line=\"$l\"; done` the inherited pipe never
      // closes, and reading it would hang and swallow the loop's own input.
      const stdin =
        route === undefined || args.length > 0 ? undefined : await readStdin();
      settle(
        await execCommand(route, args, {
          ...options,
          ...(stdin === undefined ? {} : { stdin }),
        }),
      );
    },
  );

/**
 * The 'acp' command is the pipe an editor runs.
 *
 * An editor starts it and speaks the Agent Client Protocol over its
 * standard input and output; it forwards every message to the instance the
 * profile names, and forwards everything the instance says back. It never
 * starts an app: `craft start` owns running, which is what lets one editor
 * entry reach a laptop or a company instance by switching a profile.
 *
 * Example:
 * craft acp
 * craft acp --profile company
 * craft acp --url https://eywa.devoptix.nl --token "$TOKEN" --agent zoe
 */
program
  .command("acp")
  .description("Bridge an editor to an instance over the Agent Client Protocol")
  .option("--profile <name>", "Settings profile to select")
  .option("--url <url>", "Ops server base URL of the target instance")
  .option("--token <token>", "Bearer credential for the management door")
  .option(
    "--agent <name>",
    "Agent to talk to; the instance's default otherwise",
  )
  .action(
    async (options: {
      profile?: string;
      url?: string;
      token?: string;
      agent?: string;
    }) => {
      applyGlobalLogOptions();
      const { acpCommand } = await import("./acp.js");
      // Standard output is the protocol's, and `settle` writes there only
      // for a result carrying `output`, which this one never does. What it
      // adds is the awaited write: an editor spawns this with a pipe on
      // standard error, where an exit discards whatever is still queued.
      settle(await acpCommand(options));
    },
  );

/**
 * The 'ops' command family reads a running instance's own state.
 *
 * Grouped by operator task rather than by URL prefix: `craft ops health`
 * reads `/health/**` while `craft ops routes` reads `/ops/routes`, because
 * the two surfaces have deliberately different auth postures and the
 * command family answers a different question from the path layout.
 *
 * Example:
 * craft ops health
 * craft ops routes --dispatchable
 */
const ops = program
  .command("ops")
  .description(
    "Inspect a running instance: health, readiness, routes, indicators",
  );

function opsOption<T extends import("commander").Command>(command: T): T {
  return command
    .option("--profile <name>", "Settings profile to select")
    .option("--url <url>", "Ops server base URL of the target instance")
    .option("--token <token>", "Bearer credential for the management door")
    .option("--format <format>", "pretty (default), json, or raw") as T;
}

opsOption(
  ops
    .command("health")
    .description("Operational health: every component, whatever its domain"),
).action(async (options: Record<string, string>) => {
  applyGlobalLogOptions();
  const { healthCommand } = await import("./ops.js");
  settle(await healthCommand(options));
});

opsOption(
  ops
    .command("ready")
    .description("Readiness: whether this replica should receive traffic"),
).action(async (options: Record<string, string>) => {
  applyGlobalLogOptions();
  const { readyCommand } = await import("./ops.js");
  settle(await readyCommand(options));
});

opsOption(
  ops
    .command("routes")
    .description("List routes, or describe one")
    .argument("[id]", "Route id; omit to list")
    .option("--dispatchable", "Only routes that can be dispatched to")
    .option("--source <kind>", "Only routes carrying a source of this kind"),
).action(
  async (
    id: string | undefined,
    options: {
      dispatchable?: boolean;
      source?: string;
      profile?: string;
      url?: string;
      token?: string;
      format?: string;
    },
  ) => {
    applyGlobalLogOptions();
    const { routesCommand, routeCommand } = await import("./ops.js");
    settle(
      id === undefined
        ? await routesCommand(options)
        : await routeCommand(id, options),
    );
  },
);

opsOption(
  ops
    .command("indicators")
    .description("List indicators, or read one")
    .argument("[name]", "Indicator name; omit to list"),
).action(async (name: string | undefined, options: Record<string, string>) => {
  applyGlobalLogOptions();
  const { indicatorsCommand, indicatorCommand } = await import("./ops.js");
  settle(
    name === undefined
      ? await indicatorsCommand(options)
      : await indicatorCommand(name, options),
  );
});

/**
 * The 'tui' command launches the Terminal UI for monitoring Routecraft execution.
 *
 * Example:
 * craft tui
 * craft tui --db .routecraft/telemetry.db
 */
program
  .command("tui")
  .description("Launch the Terminal UI to monitor Routecraft execution history")
  .option(
    "--db <path>",
    "Path to the telemetry SQLite database",
    ".routecraft/telemetry.db",
  )
  .action(async (options) => {
    const { resolve, isAbsolute } = await import("node:path");
    const dbPath = isAbsolute(options.db)
      ? options.db
      : resolve(process.cwd(), options.db);

    const { renderTui } = await import("./tui/app.js");
    await renderTui(dbPath);
  });

// Parse the command line arguments and execute the appropriate command
program.parse();
