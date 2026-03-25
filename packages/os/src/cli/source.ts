import { basename } from "node:path";
import type { Exchange, ExchangeHeaders } from "@routecraft/routecraft";
import type { Source } from "@routecraft/routecraft";
import type { CraftContext } from "@routecraft/routecraft";
import { rcError, RUNNER_ARGV } from "@routecraft/routecraft";
import type { CliServerOptions } from "./types.ts";
import {
  ADAPTER_CLI_PARSED,
  ADAPTER_CLI_NAME,
  getCliRegistry,
  registerCliRoute,
} from "./shared.ts";
import { buildAndParse, type CliParseResult } from "./parser.ts";

/**
 * Source adapter that receives a single CLI command invocation.
 *
 * Registered via `cli('command', options)`. On `subscribe()`:
 * 1. Registers command metadata in the context store (synchronous).
 * 2. Yields one microtask so all concurrent sources finish registering.
 * 3. First source to continue builds a commander program from the full
 *    registry and parses argv; result is cached in the context store.
 * 4. Each source reads the cached result and dispatches if matched.
 *
 * @internal Use the `cli()` factory instead of constructing this directly.
 */
export class CliSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId: string = "routecraft.adapter.cli";

  constructor(
    private command: string,
    private options: CliServerOptions = {},
  ) {}

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    // 1. Register command metadata synchronously so all concurrent sources
    //    populate the registry before any async work begins.
    const metadata: import("./types.ts").CliRouteMetadata = {
      command: this.command,
    };
    if (this.options.description !== undefined) {
      metadata.description = this.options.description;
    }
    if (this.options.schema !== undefined) {
      // Schema mode
      metadata.schema = this.options.schema;
    } else {
      // Native mode -- copy args and flags if present
      if (this.options.args !== undefined) {
        metadata.args = this.options.args;
      }
      if (this.options.flags !== undefined) {
        metadata.flags = this.options.flags;
      }
    }
    if (this.options.examples !== undefined) {
      metadata.examples = this.options.examples;
    }
    registerCliRoute(context, this.command, metadata);

    onReady?.();

    // 2. Read argv from context store. If not set, this is not a CLI-dispatched
    //    run (e.g. tests, programmatic use) -- register only, do not fire.
    const argv = context.getStore(RUNNER_ARGV);
    if (!argv) {
      context.logger.debug(
        { command: this.command, adapter: "cli" },
        "No RUNNER_ARGV in context store; CLI source registered without firing",
      );
      return;
    }

    // 3. Yield one microtask. context.start() calls subscribe() for all routes
    //    via Promise.allSettled(routes.map(...)). Each synchronous registration
    //    above completes before this yield, so after resuming the full registry
    //    is available.
    await Promise.resolve();

    // 4. First source to continue runs the centralized commander parser;
    //    result is cached for all subsequent sources. Only the first source
    //    prints output (help, errors) to avoid duplicates.
    let parsed = context.getStore(ADAPTER_CLI_PARSED) as
      | CliParseResult
      | undefined;
    const isFirstSource = !parsed;
    if (!parsed) {
      const scriptName = this.resolveScriptName(context);
      const registry = getCliRegistry(context);
      parsed = buildAndParse(scriptName, registry, argv);
      context.setStore(ADAPTER_CLI_PARSED, parsed);
    }

    // 5. Handle output (help, version, errors) -- first source only
    if (parsed.kind === "output") {
      if (isFirstSource) {
        if (parsed.exitCode === 0) {
          // eslint-disable-next-line no-console
          console.log(parsed.text);
        } else {
          // eslint-disable-next-line no-console
          console.error(parsed.text);
        }
      }
      return;
    }

    // 6. Not my command: return silently
    if (parsed.command !== this.command) {
      context.logger.debug(
        { command: this.command, invoked: parsed.command, adapter: "cli" },
        "CLI command not matched; skipping",
      );
      return;
    }

    // 7. Matched! Validate body with schema if present.
    context.logger.debug(
      { command: this.command, adapter: "cli" },
      "CLI command matched; dispatching",
    );

    let body: T = parsed.body as T;
    if (this.options.schema) {
      let result = this.options.schema["~standard"].validate(parsed.body);
      if (result instanceof Promise) result = await result;

      const issues = (result as { issues?: unknown }).issues;
      if (issues !== undefined && issues !== null) {
        const causeMessage =
          typeof issues === "object" ? JSON.stringify(issues) : String(issues);
        abortController.abort();
        throw rcError("RC5002", new Error(causeMessage), {
          message: `CLI flag validation failed for command "${this.command}"`,
        });
      }

      const value = (result as { value?: T }).value;
      if (value !== undefined) {
        body = value;
      }
    }

    context.logger.debug(
      { command: this.command, adapter: "cli" },
      "Dispatching CLI command handler",
    );

    try {
      await handler(body);
    } finally {
      abortController.abort();
    }
  }

  /**
   * Derive a human-readable script name for help text.
   * Prefers ADAPTER_CLI_NAME from context (set by cliRunner), falls back
   * to basename of the entry script from process.argv.
   */
  private resolveScriptName(context: CraftContext): string {
    return (
      (context.getStore(ADAPTER_CLI_NAME) as string | undefined) ??
      basename(process.argv[1] ?? "cli")
    );
  }
}
