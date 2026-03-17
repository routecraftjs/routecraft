/**
 * Programmatic entry point for running routecraft CLI routes as a standalone binary.
 *
 * Import from `@routecraft/cli/runner` to avoid triggering the CLI
 * argument parser that runs when importing `@routecraft/cli` directly.
 *
 * @example
 * ```typescript
 * import { cliRunner } from '@routecraft/cli/runner';
 * ```
 *
 * @packageDocumentation
 */
export { cliRunner } from "./run.ts";
