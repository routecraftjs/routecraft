import type { Exchange, ExchangeHeaders } from "../../exchange";
import type { Source } from "../../operations/from";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import type { CliServerOptions } from "./types";
import {
  ADAPTER_CLI_ARGS,
  ADAPTER_CLI_REGISTRY,
  extractJsonSchema,
  parseFlags,
  registerCliRoute,
} from "./shared";

/**
 * CliSourceAdapter implements the Source interface for the CLI adapter.
 *
 * When `.from(cli('command', options))` is used, this adapter:
 * 1. Registers the command in the context store for help generation
 * 2. Checks if this command was invoked via argv
 * 3. If yes: parses flags, validates with schema, calls handler once, then stops
 * 4. If no (different command invoked): resolves without calling handler
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

    // If no CLI args in context, this is not a CLI-dispatched run -- do nothing
    if (!parsedArgs) {
      context.logger.debug(
        { command: this.command, adapter: "cli" },
        "No CLI args in context store; skipping CLI source",
      );
      return;
    }

    // Only fire if this command was invoked
    if (parsedArgs.command !== this.command) {
      context.logger.debug(
        { command: this.command, invoked: parsedArgs.command, adapter: "cli" },
        "CLI command not invoked; skipping",
      );
      return;
    }

    context.logger.debug(
      { command: this.command, adapter: "cli" },
      "CLI command matched; parsing flags",
    );

    // Extract JSON Schema for flag parsing (if schema provided)
    const jsonSchema = this.options.schema
      ? extractJsonSchema(this.options.schema)
      : undefined;

    // Parse raw argv flags into an object
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

  /**
   * Check whether this adapter is the CLI source adapter.
   * Used by the CLI runner to detect CLI-mode files.
   */
  static isCli(source: unknown): source is CliSourceAdapter {
    return (
      typeof source === "object" &&
      source !== null &&
      "adapterId" in source &&
      (source as { adapterId: string }).adapterId === "routecraft.adapter.cli"
    );
  }

  /**
   * Collect all CLI route metadata from registered sources in the CLI registry.
   * Used by run.ts for help generation after context.build().
   */
  static getRegistry(
    context: CraftContext,
  ): Map<string, import("./types").CliRouteMetadata> {
    return (
      (context.getStore(ADAPTER_CLI_REGISTRY) as
        | Map<string, import("./types").CliRouteMetadata>
        | undefined) ?? new Map()
    );
  }
}
