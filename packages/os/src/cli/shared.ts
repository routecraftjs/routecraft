import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "@routecraft/routecraft";
import type { CliRouteMetadata } from "./types";

/**
 * Store key for the CLI route registry (command -> metadata).
 *
 * Access after `context.start()` to retrieve registered command metadata.
 * @experimental
 */
export const ADAPTER_CLI_REGISTRY = Symbol.for(
  "routecraft.adapter.cli.registry",
);

/**
 * Store key used internally to ensure help/error output is printed at most
 * once when multiple CLI sources detect a help or unknown-command condition.
 * @internal
 */
export const ADAPTER_CLI_HELP_HANDLED = Symbol.for(
  "routecraft.adapter.cli.help-handled",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_CLI_REGISTRY]: Map<string, CliRouteMetadata>;
    [ADAPTER_CLI_HELP_HANDLED]: boolean;
  }
}

/**
 * Returns true if the given source adapter is a CLI source adapter.
 *
 * @param source - Any value; typically a `Source` from a `RouteDefinition`
 * @returns `true` if the source was created with `cli()`
 * @experimental
 */
export function isCliSource(source: unknown): boolean {
  return (
    typeof source === "object" &&
    source !== null &&
    "adapterId" in source &&
    (source as { adapterId: unknown }).adapterId === "routecraft.adapter.cli"
  );
}

/**
 * Retrieve the CLI command registry from a built context.
 *
 * Returns the map of command name to metadata populated during `context.start()`.
 * Returns an empty map if the context has no CLI routes.
 *
 * @param context - A built `CraftContext` after `start()` has been called
 * @returns Map of command name to `CliRouteMetadata`
 * @experimental
 */
export function getCliRegistry(
  context: CraftContext,
): Map<string, CliRouteMetadata> {
  return (
    (context.getStore(ADAPTER_CLI_REGISTRY) as
      | Map<string, CliRouteMetadata>
      | undefined) ?? new Map()
  );
}

/**
 * Register a CLI command in the context store for discovery and help generation.
 * Called internally by `CliSourceAdapter.subscribe()`.
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
 * - kebab-case flags are converted to camelCase keys
 *
 * @param rawArgs - Token array after the command name (e.g. `["--name", "Alice"]`)
 * @param jsonSchema - JSON Schema object describing the expected properties (optional)
 * @returns Parsed key-value object ready for Standard Schema validation
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

    // Boolean flag: presence alone means true
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
 * Extract a JSON Schema object from a Standard Schema instance.
 *
 * Used to derive flag names, types, and descriptions for help generation
 * and flag parsing. Falls back to `{ type: "object" }` if the schema does
 * not expose a JSON Schema accessor.
 *
 * @param schema - Any Standard Schema instance
 * @returns JSON Schema object (draft-2020-12 format)
 */
export function extractJsonSchema(
  schema: StandardSchemaV1,
): Record<string, unknown> {
  const standard = schema["~standard"];

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
 * Convert kebab-case to camelCase.
 * @example "my-flag" => "myFlag"
 */
function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
