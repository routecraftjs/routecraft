import type { StandardSchemaV1 } from "@standard-schema/spec";
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
  if (result.issues && result.issues.length > 0) {
    throw new Error(
      `mcpPlugin options validation failed: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value as McpPluginOptions;
}
