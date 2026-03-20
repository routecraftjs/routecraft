import { type CliRouteMetadata, extractJsonSchema } from "@routecraft/tools";

function kebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Generate formatted help text listing all registered CLI commands.
 *
 * @param scriptName - Basename of the script file (e.g. "mycli.ts")
 * @param registry - Map of command name to metadata from the CLI registry
 * @returns Formatted multi-line help string
 */
export function generateHelp(
  scriptName: string,
  registry: Map<string, CliRouteMetadata>,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Usage: ${scriptName} <command> [flags]`);
  lines.push("");
  lines.push("Commands:");

  const commands = [...registry.entries()];
  const maxLen = Math.max(...commands.map(([cmd]) => cmd.length), 0);

  for (const [command, meta] of commands) {
    const desc = meta.description ?? "";
    lines.push(`  ${command.padEnd(maxLen + 2)} ${desc}`);
  }

  lines.push("");
  lines.push(`Run '${scriptName} <command> --help' for command details.`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Generate help text for a single CLI command, including its flags.
 *
 * @param scriptName - Basename of the script file
 * @param command - The command name
 * @param meta - Command metadata from the CLI registry
 * @returns Formatted multi-line help string
 */
export function generateCommandHelp(
  scriptName: string,
  command: string,
  meta: CliRouteMetadata,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`${command}${meta.description ? " - " + meta.description : ""}`);
  lines.push("");
  lines.push(`Usage: ${scriptName} ${command} [flags]`);

  if (meta.schema) {
    const jsonSchema = extractJsonSchema(meta.schema);
    const properties = (jsonSchema["properties"] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const required = (jsonSchema["required"] ?? []) as string[];

    if (Object.keys(properties).length > 0) {
      lines.push("");
      lines.push("Flags:");

      const flagEntries = Object.entries(properties);
      const maxLen = Math.max(
        ...flagEntries.map(([name]) => kebabCase(name).length + 4),
        0,
      );

      for (const [name, prop] of flagEntries) {
        const flagName = `--${kebabCase(name)}`;
        const type = (prop["type"] as string) ?? "string";
        const isRequired = required.includes(name);
        const desc = (prop["description"] as string) ?? "";
        const defaultVal = prop["default"];

        let line = `  ${flagName.padEnd(maxLen + 2)}`;
        if (type !== "boolean") {
          line += ` <${type}>`;
        }
        if (isRequired) {
          line += " (required)";
        }
        if (defaultVal !== undefined) {
          line += ` [default: ${JSON.stringify(defaultVal)}]`;
        }
        if (desc) {
          line += `  ${desc}`;
        }
        lines.push(line);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
