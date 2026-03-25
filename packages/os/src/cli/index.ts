import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Source, Destination } from "@routecraft/routecraft";
import { CliSourceAdapter } from "./source.ts";
import { CliDestinationAdapter } from "./destination.ts";
import type { CliSchemaOptions, CliServerOptions } from "./types.ts";

/**
 * Creates a CLI adapter for exposing routecraft routes as CLI commands.
 *
 * Supports two modes:
 *
 * **Schema mode** -- pass a `schema` to auto-derive flags from Standard Schema
 * properties. Short aliases are auto-generated. Booleans become presence flags.
 * Portable: the same schema works across direct, MCP, and CLI adapters.
 *
 * **Native mode** -- pass `args` and/or `flags` for full CLI control: short
 * aliases, env var fallback, positional arguments, required flags, and custom
 * descriptions. Best for CLI-first tools.
 *
 * Use `cli.stdout()` and `cli.stderr()` as destinations to write output.
 *
 * @param command - Command name as it appears on the CLI (e.g. `"greet"`)
 * @param options - Schema mode or native mode options
 * @returns A `Source` that fires once when the named command is invoked
 *
 * @example Schema mode
 * ```typescript
 * cli('greet', {
 *   schema: z.object({ name: z.string(), loud: z.boolean().optional() }),
 *   description: 'Greet someone',
 * })
 * ```
 *
 * @example Native mode
 * ```typescript
 * cli('deploy', {
 *   description: 'Deploy the app',
 *   args: [{ name: 'target', description: 'Deploy target' }],
 *   flags: {
 *     dryRun: { alias: 'd', type: 'boolean', description: 'Dry run' },
 *     env: { alias: 'e', type: 'string', env: 'DEPLOY_ENV' },
 *   },
 * })
 * ```
 *
 * @experimental
 */
export function cli<S extends StandardSchemaV1>(
  command: string,
  options: CliSchemaOptions & { schema: S },
): Source<StandardSchemaV1.InferOutput<S>>;
export function cli(
  command: string,
  options?: CliServerOptions,
): Source<unknown>;
export function cli(
  command: string,
  options: CliServerOptions = {},
): Source<unknown> {
  return new CliSourceAdapter(command, options);
}

/**
 * Writes route output to stdout.
 *
 * Strings are written as-is with a trailing newline. Objects and arrays are
 * pretty-printed as JSON. All other values are converted via `String()`.
 *
 * @returns A `Destination` that writes to `process.stdout`
 * @experimental
 */
cli.stdout = function (): Destination<unknown, void> {
  return new CliDestinationAdapter({ stream: "stdout" });
};

/**
 * Writes route output to stderr.
 *
 * Strings are written as-is with a trailing newline. Objects and arrays are
 * pretty-printed as JSON. All other values are converted via `String()`.
 *
 * @returns A `Destination` that writes to `process.stderr`
 * @experimental
 */
cli.stderr = function (): Destination<unknown, void> {
  return new CliDestinationAdapter({ stream: "stderr" });
};

// Re-export public types
export type {
  CliServerOptions,
  CliSchemaOptions,
  CliNativeOptions,
  CliClientOptions,
  CliRouteMetadata,
  CliNativeArg,
  CliNativeFlag,
} from "./types.ts";

// Re-export store keys, discovery utilities, and parsing
export {
  ADAPTER_CLI_REGISTRY,
  isCliSource,
  getCliRegistry,
  parseFlags,
  extractJsonSchema,
} from "./shared.ts";

export { cliRunner } from "./runner.ts";
