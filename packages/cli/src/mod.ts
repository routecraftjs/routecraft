#!/usr/bin/env node

/**
 * Routecraft CLI Module
 *
 * This module provides the command-line interface for Routecraft.
 */
import { Command } from "commander";
import { runCommand } from "./run.ts";
import { startCommand } from "./start.ts";
import { loadEnvFile } from "./util.ts";

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
  .option("-w, --watch", "Restart on file changes (dev mode)")
  .option(
    "--env <path>",
    "Load environment variables from a .env file (default: .env)",
  )
  .action(async (path, options) => {
    // Load environment variables if specified or use default .env
    if (options.env !== undefined) {
      loadEnvFile(options.env);
    } else {
      loadEnvFile();
    }

    await runCommand(path, options.exclude, options.watch);
  });

/**
 * The 'start' command starts a Routecraft context from a config file.
 *
 * Example:
 * craft start ./config/my-config.ts
 */
program
  .command("start")
  .description(
    "Start a Routecraft context from a config file (TypeScript/JavaScript)",
  )
  .argument(
    "<config>",
    "Path to a config file exporting a CraftConfig as default",
  )
  .option("-w, --watch", "Restart on file changes (dev mode)")
  .option(
    "--env <path>",
    "Load environment variables from a .env file (default: .env)",
  )
  .action(async (configPath, options) => {
    // Load environment variables if specified or use default .env
    if (options.env !== undefined) {
      loadEnvFile(options.env);
    } else {
      loadEnvFile();
    }

    await startCommand(configPath, options.watch);
  });

// Parse the command line arguments and execute the appropriate command
program.parse();
