import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Options for a positional argument in a CLI command.
 * Each entry maps to a schema property by its `name` field.
 */
export interface CliArgOptions {
  /** Argument name. Must match a property name in the schema (if using schema). */
  name: string;
  /** Human-readable description shown in help output. */
  description?: string;
  /** Whether this argument is required. Default: true. */
  required?: boolean;
}

/**
 * Per-flag CLI-specific options that augment schema-derived behavior.
 * Keys in the `flags` record are camelCase property names matching the schema.
 */
export interface CliFlagOptions {
  /** Short alias. Single character, used as `-x`. Example: `"n"` for `--name`. */
  alias?: string;
  /** Override the help description (takes precedence over schema `.describe()`). */
  help?: string;
  /** Environment variable name to use as fallback when flag is not provided. */
  env?: string;
}

/**
 * Metadata for a discoverable CLI command route.
 * Registered in context store for help generation and dispatch.
 */
export interface CliRouteMetadata {
  command: string;
  description?: string;
  schema?: StandardSchemaV1;
  args?: CliArgOptions[];
  flags?: Record<string, CliFlagOptions>;
  examples?: string[];
}

/**
 * Options when using CLI adapter as a Server (.from()).
 * Defines the CLI command, its schema (flags), and description.
 */
export interface CliServerOptions {
  /**
   * Body validation schema. Object properties become CLI flags unless
   * listed in `args` as positional arguments.
   *
   * Behavior depends on schema library:
   * - Zod 4: z.object() strips extras (default)
   * - Valibot/ArkType: check library docs
   */
  schema?: StandardSchemaV1;

  /** Human-readable description shown in help output. */
  description?: string;

  /**
   * Positional arguments for this command. Each entry maps to a schema
   * property by name. Properties listed here become positional args
   * instead of flags.
   *
   * @example
   * ```typescript
   * args: [{ name: 'target', description: 'Deploy target' }]
   * // Usage: deploy prod --dry-run
   * ```
   */
  args?: CliArgOptions[];

  /**
   * Per-flag CLI-native options, keyed by the camelCase property name.
   * Augments schema-derived behavior with aliases, env fallback, and
   * custom help text.
   *
   * @example
   * ```typescript
   * flags: {
   *   name: { alias: 'n', env: 'GREET_NAME' },
   *   verbose: { alias: 'v' },
   * }
   * ```
   */
  flags?: Record<string, CliFlagOptions>;

  /**
   * Usage examples shown in per-command help output.
   * Each entry is a command invocation (without the script name prefix).
   *
   * @example
   * ```typescript
   * examples: ['greet --name Alice', 'greet -n Bob --loud']
   * ```
   */
  examples?: string[];
}

/**
 * Options when using CLI adapter as a Client (.to()).
 */
export interface CliClientOptions {
  /** Output stream: "stdout" (default) or "stderr". */
  stream?: "stdout" | "stderr";
}
