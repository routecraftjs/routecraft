import { Command, CommanderError, Option } from "commander";
import type { CliRouteMetadata } from "./types.ts";
import { extractJsonSchema, parseFlags } from "./shared.ts";

function kebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Result of parsing CLI arguments with commander. */
export type CliParseResult =
  | { kind: "command"; command: string; body: Record<string, unknown> }
  | { kind: "output"; text: string; exitCode: number };

/**
 * Build a commander program from the CLI registry and parse argv.
 *
 * Uses commander for command routing, help generation, and flag parsing.
 * For commands with a schema, flags are defined from schema properties
 * (enriched with alias/env/help from `flags` options). For schema-less
 * commands, raw flags are parsed via `parseFlags` as a fallback.
 *
 * @param scriptName - Binary name for help text
 * @param registry - Map of command name to metadata
 * @param argv - CLI arguments (without node and script path)
 * @returns Parsed result: matched command with body, or output text
 *
 * @internal
 */
export function buildAndParse(
  scriptName: string,
  registry: Map<string, CliRouteMetadata>,
  argv: string[],
): CliParseResult {
  const program = new Command(scriptName);
  program.exitOverride();
  program.helpCommand(false);
  program.usage("<command> [options]");
  program.addHelpText(
    "after",
    `\nRun '${scriptName} <command> --help' for command details.`,
  );

  let capturedOutput = "";
  program.configureOutput({
    writeOut: (str: string) => {
      capturedOutput += str;
    },
    writeErr: (str: string) => {
      capturedOutput += str;
    },
  });

  let result: { command: string; body: Record<string, unknown> } | undefined;

  for (const [name, meta] of registry) {
    const cmd = program.command(name);
    if (meta.description) cmd.description(meta.description);

    const hasSchema = !!meta.schema;
    const jsonSchema = meta.schema ? extractJsonSchema(meta.schema) : undefined;
    const properties = (jsonSchema?.["properties"] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const argNames = new Set((meta.args ?? []).map((a) => a.name));
    const argDefs = meta.args ?? [];

    // Add positional arguments
    for (const arg of argDefs) {
      const bracket =
        arg.required !== false ? `<${arg.name}>` : `[${arg.name}]`;
      cmd.argument(bracket, arg.description);
    }

    if (hasSchema) {
      // Define commander options from schema properties (excluding positionals)
      for (const [prop, propSchema] of Object.entries(properties)) {
        if (argNames.has(prop)) continue;

        const flagOpts = meta.flags?.[prop];
        const kebab = kebabCase(prop);
        const type = propSchema["type"] as string | undefined;
        const desc =
          flagOpts?.help ?? (propSchema["description"] as string) ?? "";
        const alias = flagOpts?.alias ? `-${flagOpts.alias}, ` : "";

        let option: Option;
        if (type === "boolean") {
          option = new Option(`${alias}--${kebab}`, desc);
        } else {
          const typeLabel =
            type === "number" || type === "integer" ? "number" : "value";
          option = new Option(`${alias}--${kebab} <${typeLabel}>`, desc);
          if (type === "number" || type === "integer") {
            option.argParser(parseFloat);
          }
        }

        if (flagOpts?.env) {
          option.env(flagOpts.env);
        }

        const defaultVal = propSchema["default"];
        if (defaultVal !== undefined) {
          option.default(defaultVal);
        }

        cmd.addOption(option);
      }
    } else {
      // Schema-less: accept unknown options and parse them with parseFlags
      cmd.allowUnknownOption();
      cmd.allowExcessArguments();
    }

    // Add examples as help text
    if (meta.examples?.length) {
      cmd.addHelpText(
        "after",
        "\nExamples:\n" +
          meta.examples.map((e) => `  $ ${scriptName} ${e}`).join("\n"),
      );
    }

    // Action handler
    cmd.action((...actionArgs: unknown[]) => {
      const cmdObj = actionArgs[actionArgs.length - 1] as Command;
      actionArgs.pop(); // Command object
      const opts = actionArgs.pop() as Record<string, unknown>;
      const positionals = actionArgs as string[];

      const body: Record<string, unknown> = {};

      if (hasSchema) {
        // Commander parsed all known flags into opts
        Object.assign(body, opts);
      } else {
        // Schema-less: commander put unknown tokens in command.args
        Object.assign(body, parseFlags(cmdObj.args));
      }

      // Merge declared positional arguments by name
      for (let i = 0; i < argDefs.length && i < positionals.length; i++) {
        const argDef = argDefs[i]!;
        let value: unknown = positionals[i];

        // Try JSON parse for complex data (objects, arrays)
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            if (typeof parsed === "object" && parsed !== null) {
              value = parsed;
            }
          } catch {
            // Not JSON, keep as string
          }
        }

        // Coerce based on schema type
        if (typeof value === "string") {
          const propType = properties[argDef.name]?.["type"] as
            | string
            | undefined;
          if (propType === "number" || propType === "integer") {
            value = Number(value);
          }
        }

        body[argDef.name] = value;
      }

      result = { command: name, body };
    });
  }

  try {
    program.parse(["node", scriptName, ...argv]);
  } catch (err: unknown) {
    if (err instanceof CommanderError) {
      return { kind: "output", text: capturedOutput, exitCode: err.exitCode };
    }
    throw err;
  }

  if (result) {
    return { kind: "command", command: result.command, body: result.body };
  }

  // No command matched (empty argv, no subcommand given) -- show help
  return {
    kind: "output",
    text: capturedOutput || program.helpInformation(),
    exitCode: 0,
  };
}
