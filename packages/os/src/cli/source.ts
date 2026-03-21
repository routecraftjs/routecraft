import type { Exchange, ExchangeHeaders } from "@routecraft/routecraft";
import type { Source } from "@routecraft/routecraft";
import type { CraftContext } from "@routecraft/routecraft";
import { rcError } from "@routecraft/routecraft";
import type { CliServerOptions } from "./types";
import {
  ADAPTER_CLI_ARGS,
  extractJsonSchema,
  parseFlags,
  registerCliRoute,
} from "./shared";

/**
 * Source adapter that receives a single CLI command invocation.
 *
 * Registered via `cli('command', options)`. On `subscribe()`:
 * 1. Registers command metadata in the context store for help generation.
 * 2. Reads parsed args from the `ADAPTER_CLI_ARGS` store (set by the CLI runner).
 * 3. If this command was invoked: parses flags, validates via Standard Schema, calls
 *    handler once, then aborts the route.
 * 4. If a different command was invoked (or no args in store): returns immediately.
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
    // Register command metadata for help generation and discovery
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

    // Read parsed CLI invocation from context store (set by craft run before start)
    const parsedArgs = context.getStore(ADAPTER_CLI_ARGS);

    // No CLI args in store: not a CLI-dispatched run -- register only, do not fire
    if (!parsedArgs) {
      context.logger.debug(
        { command: this.command, adapter: "cli" },
        "No CLI args in context store; CLI source registered without firing",
      );
      return;
    }

    // Only fire if this command matches the invoked command
    if (parsedArgs.command !== this.command) {
      context.logger.debug(
        { command: this.command, invoked: parsedArgs.command, adapter: "cli" },
        "CLI command not matched; skipping",
      );
      return;
    }

    context.logger.debug(
      { command: this.command, adapter: "cli" },
      "CLI command matched; parsing flags",
    );

    // Extract JSON Schema for flag type hints (used by flag parser for coercion)
    const jsonSchema = this.options.schema
      ? extractJsonSchema(this.options.schema)
      : undefined;

    // Parse raw argv tokens into an object
    const parsed = parseFlags(parsedArgs.rawArgs, jsonSchema);

    // Validate with Standard Schema if provided
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
}
