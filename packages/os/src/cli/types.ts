import type { StandardSchemaV1 } from "@standard-schema/spec";

// ── Native mode types ──────────────────────────────────────────

/**
 * A positional argument definition for native CLI mode.
 */
export interface CliNativeArg {
  /** Argument name, used in help text and as the body property key. */
  name: string;
  /** Argument type for parsing. Default: `"string"`. */
  type?: "string" | "number";
  /** Description shown in help text. */
  description?: string;
  /** Whether this argument is required. Default: `true`. */
  required?: boolean;
}

/**
 * A named flag definition for native CLI mode.
 */
export interface CliNativeFlag {
  /** Flag type for parsing and help text. Default: `"string"`. */
  type?: "string" | "number" | "boolean";
  /** Short alias character (e.g. `"n"` renders as `-n`). */
  alias?: string;
  /** Description shown in help text. */
  description?: string;
  /** Default value when flag is not provided. */
  default?: string | number | boolean;
  /** Environment variable name to use as fallback. */
  env?: string;
  /** Whether this flag is required. Default: `false`. */
  required?: boolean;
}

// ── Server options (either schema OR native) ───────────────────

/**
 * Schema mode: derive CLI flags from a Standard Schema.
 *
 * Properties become `--kebab-case` flags. Short aliases are auto-generated
 * from the first letter of each property name. Booleans become presence
 * flags. Help text comes from `.describe()`. Defaults come from the schema.
 *
 * Best for portability -- the same schema works across direct, MCP, and CLI.
 */
export interface CliSchemaOptions {
  /** Standard Schema for validation. Properties become CLI flags. */
  schema: StandardSchemaV1;
  /** Command description shown in help output. */
  description?: string;
  /** Usage examples shown in per-command help. */
  examples?: string[];
}

/**
 * Native mode: full CLI control without a schema.
 *
 * Define positional arguments and named flags explicitly. The adapter
 * handles parsing, type coercion, help generation, and required-field
 * validation via commander.
 *
 * Best for CLI-first tools that need aliases, env vars, positional args,
 * and fine-grained control over the CLI interface.
 */
export interface CliNativeOptions {
  /** Must not be set in native mode. */
  schema?: undefined;
  /** Command description shown in help output. */
  description?: string;
  /** Positional arguments in order. */
  args?: CliNativeArg[];
  /** Named flags keyed by camelCase name. */
  flags?: Record<string, CliNativeFlag>;
  /** Usage examples shown in per-command help. */
  examples?: string[];
}

/**
 * Options when using CLI adapter as a Server (`.from()`).
 *
 * Pass a `schema` for schema mode (portable, auto-generated CLI) or
 * `args`/`flags` for native mode (full CLI control). Never both.
 */
export type CliServerOptions = CliSchemaOptions | CliNativeOptions;

// ── Metadata ───────────────────────────────────────────────────

/**
 * Metadata for a discoverable CLI command route.
 * Registered in context store for help generation and dispatch.
 */
export interface CliRouteMetadata {
  command: string;
  description?: string;
  /** Schema mode: Standard Schema for validation + flag derivation. */
  schema?: StandardSchemaV1;
  /** Native mode: positional argument definitions. */
  args?: CliNativeArg[];
  /** Native mode: flag definitions. */
  flags?: Record<string, CliNativeFlag>;
  /** Usage examples for help text. */
  examples?: string[];
}

// ── Client options ─────────────────────────────────────────────

/**
 * Options when using CLI adapter as a Client (`.to()`).
 */
export interface CliClientOptions {
  /** Output stream: `"stdout"` (default) or `"stderr"`. */
  stream?: "stdout" | "stderr";
}
