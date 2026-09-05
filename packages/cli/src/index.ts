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
function applyGlobalLogOptions(): void {
  const globalOpts = program.opts();
  if (globalOpts["logLevel"] !== undefined) {
    process.env["LOG_LEVEL"] = globalOpts["logLevel"];
    process.env["CRAFT_LOG_LEVEL"] = globalOpts["logLevel"];
  }
  if (globalOpts["logFile"] !== undefined) {
    process.env["LOG_FILE"] = globalOpts["logFile"];
    process.env["CRAFT_LOG_FILE"] = globalOpts["logFile"];
  }
}

/**
 * The 'run' command executes routes from a single file.
 *
 * Example:
 * craft run ./my-routes.ts
 * craft run ./my-cli.ts greet --name World
 */
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
  .passThroughOptions()
  .action(async (filePath, args: string[], options) => {
    applyGlobalLogOptions();

    const { loadEnvFile } = await import("./util.js");
    if (options.env !== undefined) {
      loadEnvFile(options.env);
    } else {
      loadEnvFile();
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
  .action(
    async (
      dir: string | undefined,
      options: { env?: string; once?: boolean; timeout?: string },
    ) => {
      applyGlobalLogOptions();

      const { resolve: resolvePath } = await import("node:path");
      const projectRoot = resolvePath(process.cwd(), dir ?? ".");

      const { loadEnvFile } = await import("./util.js");
      // The conventional .env pair belongs to the project being started,
      // not to whatever directory the shell happens to sit in.
      loadEnvFile(options.env, projectRoot);

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
  .option("--url <url>", "Ops server base URL of the target instance")
  .option("--token <token>", "Bearer credential for the management door")
  .option("--format <format>", "pretty (default), json, or raw")
  .passThroughOptions()
  .allowUnknownOption()
  .action(
    async (
      route: string | undefined,
      args: string[],
      options: { url?: string; token?: string; format?: string },
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
 * The 'chat' command holds a conversation with an agent session on a
 * running instance: one message per line, through the route fronting
 * the agent, so the app's own guardrails run on every message.
 *
 * Example:
 * craft chat max --print
 * craft chat max --print --session feature-login
 * echo "what is left?" | craft chat max --session feature-login --format raw
 */
program
  .command("chat")
  .description(
    "Talk to an agent session on a running instance, one message per line",
  )
  .argument("[route]", "Route fronting the agent (takes { session, message })")
  .option(
    "-p, --print",
    "Run the line loop without an interface (required on a terminal until the interactive mode ships; implied by piped input)",
  )
  .option("--session <id>", "Conversation to continue; a fresh id otherwise")
  .option("--url <url>", "Ops server base URL of the target instance")
  .option("--token <token>", "Bearer credential for the management door")
  .option("--format <format>", "pretty (default), json, or raw")
  .action(
    async (
      route: string | undefined,
      options: {
        print?: boolean;
        session?: string;
        url?: string;
        token?: string;
        format?: string;
      },
    ) => {
      applyGlobalLogOptions();
      const { chatCommand } = await import("./chat.js");
      settle(await chatCommand(route, options));
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
