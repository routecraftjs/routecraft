import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../../context";
import type { CliRouteMetadata } from "./types";

/**
 * Store key for the CLI route registry (command -> metadata).
 * @internal
 */
export const ADAPTER_CLI_REGISTRY = Symbol.for(
  "routecraft.adapter.cli.registry",
);

/**
 * Store key for parsed CLI arguments set by the CLI runner before context.start().
 * @internal
 */
export const ADAPTER_CLI_ARGS = Symbol.for("routecraft.adapter.cli.args");

/**
 * Parsed CLI invocation stored in context before route execution.
 */
export interface CliParsedArgs {
  /** The command name from argv, or undefined if none provided. */
  command: string | undefined;
  /** Raw argument tokens after the command name. */
  rawArgs: string[];
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_CLI_REGISTRY]: Map<string, CliRouteMetadata>;
    [ADAPTER_CLI_ARGS]: CliParsedArgs;
  }
}

/**
 * Register a CLI command in the context store for discovery and help generation.
 */
export function registerCliRoute(
  context: CraftContext,
  command: string,
  metadata: CliRouteMetadata,
): void {
  let registry = context.getStore(ADAPTER_CLI_REGISTRY) as
    | Map<string, CliRouteMetadata>
    | undefined;

  if (!registry) {
    registry = new Map<string, CliRouteMetadata>();
    context.setStore(ADAPTER_CLI_REGISTRY, registry);
  }

  registry.set(command, metadata);

  context.logger.debug(
    { command, adapter: "cli" },
    "Registered CLI command in discoverable registry",
  );
}

/**
 * Parse raw CLI flag tokens into a key-value object using JSON Schema type hints.
 *
 * Supports:
 * - `--flag value` for string/number flags
 * - `--flag` for boolean flags (presence = true)
 * - `--no-flag` for negated booleans (false)
 *
 * @param rawArgs - Tokens after the command name
 * @param jsonSchema - JSON Schema describing the expected flags (optional)
 * @returns Parsed object
 */
export function parseFlags(
  rawArgs: string[],
  jsonSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (jsonSchema?.["properties"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  let i = 0;
  while (i < rawArgs.length) {
    const token = rawArgs[i]!;

    // Handle --no-flag negation
    if (token.startsWith("--no-")) {
      const flagName = camelCase(token.slice(5));
      result[flagName] = false;
      i++;
      continue;
    }

    if (!token.startsWith("--")) {
      i++;
      continue;
    }

    const flagName = camelCase(token.slice(2));
    const propSchema = properties[flagName] as
      | Record<string, unknown>
      | undefined;
    const propType = propSchema?.["type"] as string | undefined;

    // Boolean flag: no next value or next value is another flag
    if (propType === "boolean") {
      result[flagName] = true;
      i++;
      continue;
    }

    // Peek at next token
    const nextToken = rawArgs[i + 1];
    if (nextToken === undefined || nextToken.startsWith("--")) {
      // No value provided; treat as boolean true
      result[flagName] = true;
      i++;
      continue;
    }

    // Coerce based on JSON Schema type
    if (propType === "number" || propType === "integer") {
      result[flagName] = Number(nextToken);
    } else {
      result[flagName] = nextToken;
    }
    i += 2;
  }

  return result;
}

/**
 * Extract JSON Schema from a Standard Schema instance.
 * Falls back to `{ type: "object" }` if extraction fails.
 */
export function extractJsonSchema(
  schema: StandardSchemaV1,
): Record<string, unknown> {
  const standard = schema["~standard"];

  // Try input JSON Schema (preferred for CLI flag generation)
  const jsonSchemaAccessor = standard as {
    jsonSchema?: {
      input?: (opts: { target: string }) => unknown;
    };
  };

  if (jsonSchemaAccessor.jsonSchema?.input) {
    const out = jsonSchemaAccessor.jsonSchema.input({
      target: "draft-2020-12",
    });
    if (typeof out === "object" && out !== null) {
      return out as Record<string, unknown>;
    }
  }

  return { type: "object" };
}

/**
 * Generate formatted help text for all registered CLI commands.
 */
export function generateHelp(
  scriptName: string,
  registry: Map<string, CliRouteMetadata>,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Usage: craft run ${scriptName} <command> [flags]`);
  lines.push("");
  lines.push("Commands:");

  // Find max command length for alignment
  const commands = [...registry.entries()];
  const maxLen = Math.max(...commands.map(([cmd]) => cmd.length), 0);

  for (const [command, meta] of commands) {
    const desc = meta.description ?? "";
    lines.push(`  ${command.padEnd(maxLen + 2)} ${desc}`);
  }

  lines.push("");
  lines.push(
    `Run 'craft run ${scriptName} <command> --help' for command details.`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Generate help text for a single CLI command, including its flags.
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
  lines.push(`Usage: craft run ${scriptName} ${command} [flags]`);

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

/**
 * Convert kebab-case to camelCase.
 * @example "my-flag" -> "myFlag"
 */
function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Convert camelCase to kebab-case.
 * @example "myFlag" -> "my-flag"
 */
function kebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
