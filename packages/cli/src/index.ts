#!/usr/bin/env node

/**
 * Routecraft CLI Module
 *
 * This module provides the command-line interface for Routecraft.
 */
import { Command } from "commander";
import { runCommand } from "./run.ts";
import { loadEnvFile } from "./util.ts";

/**
 * The main command program for the Routecraft CLI.
 * Built using the commander.js library.
 */
const program = new Command();

program
  .name("craft")
  .description("A modern routing framework for TypeScript")
  .version("0.1.1")
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
      process.exit(result.code ?? 1);
    }
  });

// Parse the command line arguments and execute the appropriate command
program.parse();
