import { parseArgs } from "@std/cli";
import { runCommand } from "./run.ts";

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["path"],
    alias: {
      p: "path",
      h: "help",
      v: "version",
    },
    boolean: ["help", "version"],
  });

  const command = args._[0] as string | undefined;
  const path = args.path as string | undefined;
  const help = args.help as boolean | undefined;
  const version = args.version as boolean | undefined;

  const showHelp = () => {
    console.log(`
Routecraft CLI - A modern routing framework for TypeScript

USAGE:
    craft [OPTIONS] <COMMAND>

COMMANDS:
    run                         Run routes from a TypeScript file or directory
        -p, --path <path>       Path to a TypeScript file or directory

GLOBAL OPTIONS:
    -h, --help                  Print help information
    -v, --version               Print version information

VERSION:
    0.1.0
`);
    Deno.exit(0);
  };

  if (help) {
    showHelp();
  }

  if (version) {
    console.log("craft v0.1.0");
    Deno.exit(0);
  }

  switch (command) {
    case "run":
      await runCommand(path);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log("Run 'craft --help' for usage information");
      Deno.exit(1);
  }
}
