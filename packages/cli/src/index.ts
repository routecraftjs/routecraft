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

// ── 2. Re-exec with TypeScript strip flags if a .ts file is being run ───────
// Node 22.6+: --experimental-strip-types must be present in execArgv for
// import() to handle .ts files. Node 23.6+: types are stripped by default.
const hasTSFile = process.argv
  .slice(2)
  .some((arg) => !arg.startsWith("-") && arg.endsWith(".ts"));

if (hasTSFile) {
  const atLeast226 = major > 22 || (major === 22 && minor >= 6);
  const atLeast236 = major > 23 || (major === 23 && minor >= 6);

  if (!atLeast226) {
    // eslint-disable-next-line no-console
    console.error(
      `[routecraft] Running .ts files directly requires Node.js 22.6 or later. ` +
        `You are on ${process.version}. Please upgrade Node or compile your file first.`,
    );
    process.exit(1);
  }

  const hasStripFlag = process.execArgv.some(
    (a) => a === "--experimental-strip-types" || a === "--strip-types",
  );

  if (!atLeast236 && !hasStripFlag) {
    // Re-exec the current process with --experimental-strip-types so that
    // the subsequent import() call in run.ts can load the .ts file.
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          ...process.execArgv,
          process.argv[1]!,
          ...process.argv.slice(2),
        ],
        { stdio: "inherit" },
      );
      process.exit(0);
    } catch (err: unknown) {
      process.exit(
        (err as NodeJS.ErrnoException & { status?: number }).status ?? 1,
      );
    }
  }
}

// ── 3. CLI definition (only Commander; run/util are lazy-loaded so logger sees env) ─
const { Command } = await import("commander");
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version("0.3.0")
  .option(
    "--log-level <level>",
    "Log level (e.g. info, warn, error, silent to disable)",
  )
  .option(
    "--log-file <path>",
    "Write logs to a file (keeps stdout clear for MCP stdio)",
  )
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
 */
program
  .command("run")
  .description("Run routes from a single TypeScript/JavaScript file")
  .argument("<file>", "Path to a file containing routes")
  .option(
    "--env <path>",
    "Load environment variables from a .env file (default: .env)",
  )
  .action(async (filePath, options) => {
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
    const result = await runCommand(filePath);
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

// Parse the command line arguments and execute the appropriate command
program.parse();
