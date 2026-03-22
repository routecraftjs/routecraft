import { basename } from "node:path";
import type { Exchange, ExchangeHeaders } from "@routecraft/routecraft";
import type { Source } from "@routecraft/routecraft";
import type { CraftContext } from "@routecraft/routecraft";
import { rcError, RUNNER_ARGV } from "@routecraft/routecraft";
import type { CliServerOptions } from "./types";
import {
  ADAPTER_CLI_HELP_HANDLED,
  extractJsonSchema,
  getCliRegistry,
  parseFlags,
  registerCliRoute,
} from "./shared";
import { generateHelp, generateCommandHelp } from "./help";

/**
 * Source adapter that receives a single CLI command invocation.
 *
 * Registered via `cli('command', options)`. On `subscribe()`:
 * 1. Registers command metadata in the context store (synchronous).
 * 2. Yields one microtask so all concurrent sources finish registering.
 * 3. Reads argv from the `RUNNER_ARGV` store (set by runner or `cliRunner()`).
 * 4. If no argv in store: registers only, does not fire.
 * 5. Handles help printing, unknown-command errors, and dispatch internally.
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
    const metadata: import("./types").CliRouteMetadata = {
      command: this.command,
    };
    if (this.options.description !== undefined) {
      metadata.description = this.options.description;
    }
    if (this.options.schema !== undefined) {
      metadata.schema = this.options.schema;
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

    // 4. Parse command from argv
    const command = argv.find((a) => !a.startsWith("-"));
    const rawArgs =
      command !== undefined ? argv.slice(argv.indexOf(command) + 1) : [];

    const registry = getCliRegistry(context);
    const scriptName = context.getStore(ADAPTER_CLI_HELP_HANDLED)
      ? undefined
      : this.resolveScriptName();

    // 5a. No command or global --help: show help (once across all sources)
    if (command === undefined || (rawArgs.length === 0 && isHelpFlag(argv))) {
      this.handleOnce(context, () => {
        // eslint-disable-next-line no-console
        console.log(generateHelp(scriptName ?? "cli", registry));
      });
      return;
    }

    // 5b. Per-command --help
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      if (command === this.command) {
        // eslint-disable-next-line no-console
        console.log(
          generateCommandHelp(scriptName ?? "cli", command, metadata),
        );
      }
      return;
    }

    // 5c. Unknown command: show error (once across all sources)
    if (!registry.has(command)) {
      this.handleOnce(context, () => {
        const available = [...registry.keys()].join(", ");
        // eslint-disable-next-line no-console
        console.error(
          `Unknown command: "${command}"\n` +
            `Available commands: ${available || "(none)"}\n\n` +
            `Run '${scriptName ?? "cli"}' to see all commands.`,
        );
      });
      return;
    }

    // 6. Not my command: return silently
    if (command !== this.command) {
      context.logger.debug(
        { command: this.command, invoked: command, adapter: "cli" },
        "CLI command not matched; skipping",
      );
      return;
    }

    // 7. Matched! Parse flags and validate.
    context.logger.debug(
      { command: this.command, adapter: "cli" },
      "CLI command matched; parsing flags",
    );

    const jsonSchema = this.options.schema
      ? extractJsonSchema(this.options.schema)
      : undefined;

    const parsed = parseFlags(rawArgs, jsonSchema);

    let body: T = parsed as T;
    if (this.options.schema) {
      let result = this.options.schema["~standard"].validate(parsed);
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
   * Execute `fn` at most once across all CLI sources in this context.
   * Uses a store flag so the first source to reach this point acts;
   * subsequent sources skip.
   */
  private handleOnce(context: CraftContext, fn: () => void): void {
    const handled = context.getStore(ADAPTER_CLI_HELP_HANDLED);
    if (handled) return;
    context.setStore(ADAPTER_CLI_HELP_HANDLED, true);
    fn();
  }

  /**
   * Derive a human-readable script name for help text.
   * Uses basename of the entry script from process.argv.
   */
  private resolveScriptName(): string {
    return basename(process.argv[1] ?? "cli");
  }
}

function isHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}
