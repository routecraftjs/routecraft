import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Source } from "../../operations/from";
import type { Destination } from "../../operations/to";
import { CliSourceAdapter } from "./source";
import { CliDestinationAdapter } from "./destination";
import type { CliServerOptions } from "./types";

/**
 * Creates a CLI adapter for exposing routecraft routes as CLI commands.
 *
 * - **Source (for `.from()`):** `cli('command', options)` -- defines a CLI command with
 *   flags derived from the schema's object properties.
 * - **Destination (for `.to()`):** `cli.stdout()` or `cli.stderr()` -- writes output.
 *
 * All commands in a file are exposed under a single entrypoint:
 * - `craft run mycli.ts` -- shows help listing all commands
 * - `craft run mycli.ts <command> [--flag value ...]` -- runs the matching command
 *
 * @example
 * ```typescript
 * import { craft, cli } from '@routecraft/routecraft';
 * import { z } from 'zod';
 *
 * export default [
 *   craft('greet')
 *     .from(cli('greet', {
 *       schema: z.object({ name: z.string(), loud: z.boolean().optional() }),
 *       description: 'Greet someone',
 *     }))
 *     .transform(({ name, loud }) => loud ? `HELLO ${name.toUpperCase()}!` : `Hello, ${name}!`)
 *     .to(cli.stdout()),
 * ];
 * ```
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
 * Strings pass through as-is; objects/arrays are JSON.stringify'd.
 */
cli.stdout = function (): Destination<unknown, void> {
  return new CliDestinationAdapter({ stream: "stdout" });
};

/**
 * Writes route output to stderr.
 * Strings pass through as-is; objects/arrays are JSON.stringify'd.
 */
cli.stderr = function (): Destination<unknown, void> {
  return new CliDestinationAdapter({ stream: "stderr" });
};

// Re-export types
export type {
  CliServerOptions,
  CliClientOptions,
  CliOptions,
  CliRouteMetadata,
} from "./types";

// Re-export store keys, utilities, and help generators for CLI runner
export {
  ADAPTER_CLI_REGISTRY,
  ADAPTER_CLI_ARGS,
  type CliParsedArgs,
  generateHelp,
  generateCommandHelp,
} from "./shared";

// Re-export adapter class for detection and registry access in the CLI runner
export { CliSourceAdapter } from "./source";
