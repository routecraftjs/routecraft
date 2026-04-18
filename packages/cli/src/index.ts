#!/usr/bin/env node

/**
 * Routecraft CLI — single entry point.
 *
 * 1. Check Node version (Pino 10 needs Node 18.19+)
 * 2. Define program and parse; log options are global and applied before lazy-loading run/util (which load the logger)
 */

// ── 1. Node version gate ────────────────────────────────────────────
const [major, minor] = process.version.slice(1).split(".").map(Number) as [
  number,
  number,
];

if (!(major > 18 || (major === 18 && minor >= 19))) {
  // eslint-disable-next-line no-console
  console.error(
    `[routecraft] Node.js ${process.version} is not supported. ` +
      `Routecraft requires Node.js 18.19.0 or later (e.g. 20 or 22). ` +
      `Please upgrade Node or configure your MCP client to use a newer Node.`,
  );
  process.exit(1);
}

// ── 2. Re-exec with tsx loader if a .ts file is being run ───────────────────
// Node's native --experimental-strip-types does not handle extensionless
// imports or .js-to-.ts resolution. tsx (via --import tsx/esm) does.
// We set CRAFT_TSX_LOADER=1 before re-execing to avoid an infinite loop.
// Bun has native TypeScript support, so we skip the re-exec entirely there.
const hasTSFile = process.argv
  .slice(2)
  .some((arg) => !arg.startsWith("-") && arg.endsWith(".ts"));
const isBun = typeof process.versions["bun"] === "string";

if (hasTSFile && !isBun && !process.env["CRAFT_TSX_LOADER"]) {
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  // Resolve tsx/esm relative to the CLI package so it works regardless of CWD
  const tsxEsmPath = createRequire(import.meta.url).resolve("tsx/esm");

  // Let the child handle SIGINT/SIGTERM for graceful shutdown.
  // Without this the parent dies on the first signal, orphaning the child
  // mid-teardown (connections not closed, logs truncated).
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});

  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        tsxEsmPath,
        ...process.execArgv,
        process.argv[1]!,
        ...process.argv.slice(2),
      ],
      { stdio: "inherit", env: { ...process.env, CRAFT_TSX_LOADER: "1" } },
    );
    process.exit(0);
  } catch (err: unknown) {
    process.exit(
      (err as NodeJS.ErrnoException & { status?: number }).status ?? 1,
    );
  }
}

// ── 3. CLI definition (only Commander; run/util are lazy-loaded so logger sees env) ─
const { Command } = await import("commander");
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version("0.5.0")
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
    // Apply global log options to env before any import that creates the logger
    const globalOpts = program.opts();
    if (globalOpts["logLevel"] !== undefined) {
      process.env["LOG_LEVEL"] = globalOpts["logLevel"];
      process.env["CRAFT_LOG_LEVEL"] = globalOpts["logLevel"];
    }
    if (globalOpts["logFile"] !== undefined) {
      process.env["LOG_FILE"] = globalOpts["logFile"];
      process.env["CRAFT_LOG_FILE"] = globalOpts["logFile"];
    }

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
    // Don't call process.exit() — let the event loop drain naturally.
    // process.exit() triggers C++ static destructors that race with ONNX
    // Runtime cleanup (onnxruntime#25038: "mutex lock failed").
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
