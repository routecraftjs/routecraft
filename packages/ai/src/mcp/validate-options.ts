import type { StandardSchemaV1 } from "@standard-schema/spec";
import { formatSchemaIssues } from "@routecraft/routecraft";
import type { McpPluginOptions } from "./types.ts";

/** Standard Schema validate result: success has value, failure has issues. */
type ValidateResult<T = unknown> =
  | { value: T; issues?: never }
  | { value?: never; issues: readonly unknown[] };

/**
 * Validates MCP plugin options at apply time.
 * For full schema validation (required props, shape), use validateWithSchema() with a
 * StandardSchemaV1 from Zod, Valibot, or ArkType before calling mcpPlugin().
 */
export function validateMcpPluginOptions(options: McpPluginOptions): void {
  if (options.transport === "http") {
    if (options.port !== undefined) {
      if (typeof options.port !== "number") {
        throw new TypeError(
          "mcpPlugin: when transport is 'http', port must be a number",
        );
      }
      if (options.port < 0 || options.port > 65535) {
        throw new RangeError(
          "mcpPlugin: port must be between 0 and 65535 when transport is 'http'",
        );
      }
    }
    if (options.host !== undefined && typeof options.host !== "string") {
      throw new TypeError("mcpPlugin: when provided, host must be a string");
    }
  }

  // Validate auth options
  if (options.auth !== undefined) {
    if ("provider" in options.auth) {
      // OAuth provider auth -- validated by the oauth() factory.
      if (options.auth.provider !== "oauth") {
        throw new TypeError(
          'mcpPlugin: auth.provider must be "oauth". Use the oauth() helper.',
        );
      }
    } else if ("validator" in options.auth) {
      if (typeof options.auth.validator !== "function") {
        throw new TypeError(
          "mcpPlugin: auth.validator must be a function that returns a Principal (throw to reject)",
        );
      }
    } else {
      throw new TypeError(
        "mcpPlugin: auth must have either a 'validator' function or 'provider' set to 'oauth'. " +
          "Use jwt(), jwks(), oauth(), or a custom { validator } object.",
      );
    }
  }

  // Validate stdio client configs
  if (options.clients) {
    for (const [name, config] of Object.entries(options.clients)) {
      if (
        typeof config === "object" &&
        config !== null &&
        "transport" in config &&
        config.transport === "stdio"
      ) {
        if (!config.command || typeof config.command !== "string") {
          throw new TypeError(
            `mcpPlugin: stdio client "${name}" must have a non-empty command string`,
          );
        }
      }
    }
  }

  // Validate restart options
  if (options.maxRestarts !== undefined) {
    if (
      typeof options.maxRestarts !== "number" ||
      !Number.isInteger(options.maxRestarts) ||
      options.maxRestarts < 0
    ) {
      throw new TypeError(
        "mcpPlugin: maxRestarts must be a non-negative integer",
      );
    }
  }
  if (options.restartDelayMs !== undefined) {
    if (
      typeof options.restartDelayMs !== "number" ||
      options.restartDelayMs <= 0
    ) {
      throw new TypeError(
        "mcpPlugin: restartDelayMs must be a positive number",
      );
    }
  }
  if (options.restartBackoffMultiplier !== undefined) {
    if (
      typeof options.restartBackoffMultiplier !== "number" ||
      options.restartBackoffMultiplier < 1
    ) {
      throw new TypeError("mcpPlugin: restartBackoffMultiplier must be >= 1");
    }
  }

  // Validate HTTP tool refresh interval
  if (options.toolRefreshIntervalMs !== undefined) {
    if (
      typeof options.toolRefreshIntervalMs !== "number" ||
      !Number.isInteger(options.toolRefreshIntervalMs) ||
      options.toolRefreshIntervalMs < 0
    ) {
      throw new TypeError(
        "mcpPlugin: toolRefreshIntervalMs must be a non-negative integer",
      );
    }
  }
}

/**
 * Validate plugin options with a StandardSchemaV1 (e.g. from Zod, Valibot, ArkType).
 * Use this when you need required props or full shape validation before mcpPlugin().
 *
 * @example
 * import { z } from "zod";
 * const schema = z.object({ transport: z.enum(["stdio", "http"]), port: z.number().optional() });
 * const validated = await validateWithSchema(options, schema);
 * mcpPlugin(validated);
 */
export async function validateWithSchema(
  options: McpPluginOptions,
  schema: StandardSchemaV1,
): Promise<McpPluginOptions> {
  const standard = (
    schema as {
      "~standard"?: {
        validate: (
          v: unknown,
        ) => ValidateResult<unknown> | Promise<ValidateResult<unknown>>;
      };
    }
  )["~standard"];
  if (!standard?.validate) {
    throw new Error(
      "mcpPlugin: schema must be a StandardSchemaV1 with ~standard.validate",
    );
  }
  let result = standard.validate(options);
  if (result instanceof Promise) {
    result = await result;
  }
  if (result.issues) {
    throw new Error(
      `mcpPlugin options validation failed: ${formatSchemaIssues(result.issues)}`,
    );
  }
  // Guard against schemas that pass (no issues) but omit value
  if (result.value === undefined) {
    throw new Error("mcpPlugin options validation failed: no value returned");
  }
  return result.value as McpPluginOptions;
}
