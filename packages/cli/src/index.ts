#!/usr/bin/env node

/**
 * Routecraft CLI — single entry point.
 *
 * 1. Check Node version (Pino 10 needs Node 18.19+)
 * 2. Set LOG_FILE / LOG_LEVEL from argv before any import touches pino
 * 3. Dynamically import the rest so env is ready when the logger initialises
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

// ── 2. Early argv scan for log options (before loadEnvFile/runCommand) ─
// Only set env when user passes flags; otherwise craftConfig.log can apply when context is built
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--log-file" && process.argv[i + 1]) {
    const path = process.argv[i + 1];
    process.env["LOG_FILE"] = path;
    process.env["CRAFT_LOG_FILE"] = path;
  } else if (arg.startsWith("--log-file=")) {
    const path = arg.slice("--log-file=".length);
    process.env["LOG_FILE"] = path;
    process.env["CRAFT_LOG_FILE"] = path;
  }
  if (arg === "--log-level" && process.argv[i + 1]) {
    const level = process.argv[i + 1];
    process.env["LOG_LEVEL"] = level;
    process.env["CRAFT_LOG_LEVEL"] = level;
  } else if (arg.startsWith("--log-level=")) {
    const level = arg.slice("--log-level=".length);
    process.env["LOG_LEVEL"] = level;
    process.env["CRAFT_LOG_LEVEL"] = level;
  }
}

// ── 3. Dynamic imports (pino is loaded here, sees env vars above) ───
const { Command } = await import("commander");
const { runCommand } = await import("./run.js");
const { loadEnvFile } = await import("./util.js");

// ── 4. CLI definition ──────────────────────────────────────────────
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version("0.2.0")
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
  .option(
    "--log-file <path>",
    "Write logs to a file (keeps stdout clear for MCP stdio)",
  )
  .option(
    "--log-level <level>",
    "Log level (e.g. info, warn, error, silent to disable)",
    "warn",
  )
  .action(async (filePath, options) => {
    // Load environment variables if specified or use default .env
    if (options.env !== undefined) {
      loadEnvFile(options.env);
    } else {
      loadEnvFile();
    }

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
  });

// Parse the command line arguments and execute the appropriate command
program.parse();
