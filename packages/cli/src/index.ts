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
    "--timeout <ms>",
    "With --once, give up and exit non-zero after this many milliseconds",
  )
  .action(async (dir: string | undefined, options) => {
    applyGlobalLogOptions();

    const { resolve: resolvePath } = await import("node:path");
    const projectRoot = resolvePath(process.cwd(), dir ?? ".");

    const { loadEnvFile } = await import("./util.js");
    // The conventional .env pair belongs to the project being started,
    // not to whatever directory the shell happens to sit in.
    loadEnvFile(options.env, projectRoot);

    const { startCommand } = await import("./start.js");
    const timeoutMs =
      options.timeout === undefined ? undefined : Number(options.timeout);
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    ) {
      // eslint-disable-next-line no-console
      console.error(
        `--timeout must be a number of milliseconds, at least 1. Received "${String(options.timeout)}".`,
      );
      setImmediate(() => process.exit(1));
      return;
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
