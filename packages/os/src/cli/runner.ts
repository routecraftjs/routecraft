import {
  ContextBuilder,
  registerShutdownHandlers,
  RUNNER_ARGV,
  type RouteDefinition,
  type RouteBuilder,
} from "@routecraft/routecraft";
import { ADAPTER_CLI_NAME } from "./shared.ts";

/**
 * Run routecraft routes as a standalone CLI application.
 *
 * Creates a context from the given routes, sets `RUNNER_ARGV`, and starts it.
 * The CLI source adapters handle everything internally: help printing,
 * unknown-command errors, flag parsing, and dispatch.
 *
 * Use this to package a routecraft file as a named binary (e.g. `mycli`)
 * instead of requiring `craft run`.
 *
 * @param routes - Route definitions or route builders using `cli()` sources
 * @param options - Runner options
 * @param options.name - Binary name shown in help text (defaults to `basename(process.argv[1])`)
 * @param options.argv - CLI arguments (defaults to `process.argv.slice(2)`)
 *
 * @example
 * ```typescript
 * #!/usr/bin/env tsx
 * import { craft } from '@routecraft/routecraft';
 * import { cli, cliRunner } from '@routecraft/os';
 * import { z } from 'zod';
 *
 * const routes = [
 *   craft().id('greet')
 *     .from(cli('greet', {
 *       schema: z.object({ name: z.string() }),
 *       description: 'Say hello',
 *     }))
 *     .transform(({ name }) => `Hello, ${name}!`)
 *     .to(cli.stdout()),
 * ];
 *
 * export default routes;
 * await cliRunner(routes, { name: 'mycli' });
 * ```
 *
 * @experimental
 */
export async function cliRunner(
  routes: Array<RouteDefinition | RouteBuilder<unknown>>,
  options?: { name?: string; argv?: string[] },
): Promise<void> {
  const argv = options?.argv ?? process.argv.slice(2);

  const contextBuilder = new ContextBuilder();
  for (const route of routes) {
    contextBuilder.routes(route);
  }

  const context = await contextBuilder.build();
  context.setStore(RUNNER_ARGV, argv);
  if (options?.name) {
    context.setStore(ADAPTER_CLI_NAME, options.name);
  }
  registerShutdownHandlers(context);
  await context.start();
}
