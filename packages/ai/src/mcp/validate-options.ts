import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { McpPluginOptions } from "./types.ts";

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
 * validateWithSchema(options, schema);
 * mcpPlugin(options);
 */
export function validateWithSchema(
  options: McpPluginOptions,
  schema: StandardSchemaV1,
): McpPluginOptions {
  const standard = (
    schema as {
      "~standard"?: { validate: (v: unknown) => { value?: unknown } };
    }
  )["~standard"];
  if (!standard?.validate) {
    throw new Error(
      "mcpPlugin: schema must be a StandardSchemaV1 with ~standard.validate",
    );
  }
  const result = standard.validate(options);
  if (result.value === undefined) {
    throw new Error("mcpPlugin options validation failed");
  }
  return result.value as McpPluginOptions;
}
