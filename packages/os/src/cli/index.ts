import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Source, Destination } from "@routecraft/routecraft";
import { CliSourceAdapter } from "./source";
import { CliDestinationAdapter } from "./destination";
import type { CliServerOptions } from "./types";

/**
 * Creates a CLI adapter for exposing routecraft routes as CLI commands.
 *
 * When used as a **source** (`.from()`), each call defines one CLI command.
 * Schema properties become named flags (`--flag-name <value>`). Help text is
 * auto-generated from schema descriptions.
 *
 * When all routes in a file use `cli()` sources, `craft run` enters CLI mode:
 * - `craft run mycli.ts` -- lists all commands
 * - `craft run mycli.ts <command> [--flag value ...]` -- runs the matched command
 *
 * Use `cli.stdout()` and `cli.stderr()` as destinations to write output.
 *
 * @param command - Command name as it appears on the CLI (e.g. `"greet"`)
 * @param options - Command options: `schema` and `description`
 * @returns A `Source` that fires once when the named command is invoked
 *
 * @example
 * ```typescript
 * import { craft } from '@routecraft/routecraft';
 * import { cli } from '@routecraft/os';
 * import { z } from 'zod';
 *
 * export default [
 *   craft().id('greet')
 *     .from(cli('greet', {
 *       schema: z.object({ name: z.string(), loud: z.boolean().optional() }),
 *       description: 'Greet someone',
 *     }))
 *     .transform(({ name, loud }) =>
 *       loud ? `HELLO ${name.toUpperCase()}!` : `Hello, ${name}!`
 *     )
 *     .to(cli.stdout()),
 * ];
 * ```
 *
 * @experimental
 */
export function cli<S extends StandardSchemaV1>(
  command: string,
  options: CliServerOptions & { schema: S },
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
  CliClientOptions,
  CliOptions,
  CliRouteMetadata,
} from "./types";

// Re-export store keys, parsed args type, and discovery utilities
export {
  ADAPTER_CLI_REGISTRY,
  ADAPTER_CLI_ARGS,
  type CliParsedArgs,
  isCliSource,
  getCliRegistry,
  parseFlags,
  extractJsonSchema,
} from "./shared";
