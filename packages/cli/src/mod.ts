/**
 * Routecraft CLI Module
 *
 * This module provides the command-line interface for Routecraft.
 */
import { Command } from "commander";
import { runCommand } from "./run.ts";

/**
 * The main command program for the Routecraft CLI.
 * Built using the commander.js library.
 */
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version("0.1.0")
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
 * The 'run' command executes route configurations from files.
 *
 * Example:
 * craft run ./routes/my-route.ts
 * craft run ./routes --exclude "*.test.ts" "**//*.spec.ts"
 */
program
  .command("run")
  .description("Run routes from a TypeScript file or directory")
  .argument("<path>", "Path to a TypeScript file or directory")
  .option(
    "-e, --exclude <patterns...>",
    "Glob patterns to exclude (e.g., '*.test.ts')",
  )
  .action(async (path, options) => {
    await runCommand(path, options.exclude);
  });

// Parse the command line arguments and execute the appropriate command
program.parse();
