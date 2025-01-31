import { Command } from "commander";
import { runCommand } from "./run.ts";

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

if (process.argv.length <= 2) {
  program.help({ error: false });
}

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

program.parse();
