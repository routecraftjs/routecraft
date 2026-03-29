import { Command, CommanderError, Option } from "commander";
import type { CliRouteMetadata } from "./types.ts";
import { parseFlags } from "./shared.ts";

function kebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Result of parsing CLI arguments with commander. */
export type CliParseResult =
  | { kind: "command"; command: string; body: Record<string, unknown> }
  | { kind: "output"; text: string; exitCode: number };

/**
 * Auto-generate single-letter aliases from property names.
 * First property to claim a letter wins. Reserved letters (e.g. `h` for
 * `--help`) are skipped.
 */
function autoAliases(
  propertyNames: string[],
  reserved: Set<string>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set(reserved);

  for (const prop of propertyNames) {
    const letter = prop[0]?.toLowerCase();
    if (letter && !used.has(letter)) {
      aliases.set(prop, letter);
      used.add(letter);
    }
  }

  return aliases;
}

/**
 * Build a commander program from the CLI registry and parse argv.
 *
 * Supports two modes based on what metadata is present:
 * - **Schema mode** (`meta.schema`): flags are derived from JSON Schema
 *   properties with auto-generated aliases.
 * - **Native mode** (`meta.flags`/`meta.args`): flags and positional args
 *   are defined explicitly by the user.
 * - **No-config mode** (neither): accepts any flags via `parseFlags` fallback.
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

    const isSchemaMode = !!meta.schema;
    const isNativeMode =
      !isSchemaMode &&
      ((meta.flags && Object.keys(meta.flags).length > 0) ||
        (meta.args && meta.args.length > 0));

    if (isSchemaMode) {
      // ── Schema mode: derive flags from JSON Schema with auto-aliases ──
      // Use cached jsonSchema from registration (populated by CliSourceAdapter)
      // to avoid re-extracting on every parse call.
      const jsonSchema = meta.jsonSchema ?? { type: "object" };
      const properties = (jsonSchema["properties"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const propNames = Object.keys(properties);
      const aliases = autoAliases(propNames, new Set(["h"]));

      for (const [prop, propSchema] of Object.entries(properties)) {
        const kebab = kebabCase(prop);
        const type = propSchema["type"] as string | undefined;
        const desc = (propSchema["description"] as string) ?? "";
        const alias = aliases.get(prop);
        const aliasStr = alias ? `-${alias}, ` : "";

        let option: Option;
        if (type === "boolean") {
          option = new Option(`${aliasStr}--${kebab}`, desc);
          cmd.addOption(option);
          // Add --no-flag so users can negate booleans (e.g. --no-loud)
          cmd.addOption(new Option(`--no-${kebab}`));
        } else {
          const typeLabel =
            type === "number" || type === "integer" ? "number" : "value";
          option = new Option(`${aliasStr}--${kebab} <${typeLabel}>`, desc);
          if (type === "number" || type === "integer") {
            option.argParser(parseFloat);
          }
          const defaultVal = propSchema["default"];
          if (defaultVal !== undefined) {
            option.default(defaultVal);
          }
          cmd.addOption(option);
        }
      }
    } else if (isNativeMode) {
      // ── Native mode: use explicit flag/arg definitions ──
      if (meta.args) {
        for (const arg of meta.args) {
          const bracket =
            arg.required !== false ? `<${arg.name}>` : `[${arg.name}]`;
          cmd.argument(bracket, arg.description);
        }
      }

      if (meta.flags) {
        for (const [prop, flag] of Object.entries(meta.flags)) {
          const kebab = kebabCase(prop);
          const type = flag.type ?? "string";
          const desc = flag.description ?? "";
          const aliasStr = flag.alias ? `-${flag.alias}, ` : "";

          let option: Option;
          if (type === "boolean") {
            option = new Option(`${aliasStr}--${kebab}`, desc);
            if (flag.env) option.env(flag.env);
            cmd.addOption(option);
            // Add --no-flag so users can negate booleans (e.g. --no-loud)
            cmd.addOption(new Option(`--no-${kebab}`));
          } else {
            const typeLabel = type === "number" ? "number" : "value";
            option = new Option(`${aliasStr}--${kebab} <${typeLabel}>`, desc);
            if (type === "number") {
              option.argParser(parseFloat);
            }
            if (flag.env) option.env(flag.env);
            if (flag.default !== undefined) option.default(flag.default);
            if (flag.required) option.makeOptionMandatory();
            cmd.addOption(option);
          }
        }
      }
    } else {
      // ── No-config mode: accept anything, parse with parseFlags ──
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
    const argDefs = meta.args ?? [];
    const nativeFlags = meta.flags;
    cmd.action((...actionArgs: unknown[]) => {
      const cmdObj = actionArgs[actionArgs.length - 1] as Command;
      actionArgs.pop(); // Command object
      const opts = actionArgs.pop() as Record<string, unknown>;
      const positionals = actionArgs as string[];

      const body: Record<string, unknown> = {};

      if (isSchemaMode || isNativeMode) {
        // Commander parsed known flags into opts
        Object.assign(body, opts);
      } else {
        // No-config: extract flags from raw remaining args
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

        // Coerce based on native arg type or schema type
        if (typeof value === "string") {
          const argType = argDef.type ?? "string";
          if (argType === "number") {
            value = Number(value);
          }
        }

        body[argDef.name] = value;
      }

      // Remove commander-injected defaults for native boolean flags
      // that weren't actually passed (commander defaults booleans to undefined)
      if (nativeFlags) {
        for (const [prop, flag] of Object.entries(nativeFlags)) {
          if (
            flag.type === "boolean" &&
            flag.default === undefined &&
            body[prop] === undefined
          ) {
            delete body[prop];
          }
        }
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
