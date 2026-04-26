import type { StandardSchemaV1 } from "@standard-schema/spec";
import { formatSchemaIssues } from "@routecraft/routecraft";
import { Output, jsonSchema } from "ai";

/**
 * Build an AI SDK schema (`jsonSchema(...)`) from a Standard Schema. The
 * `direction` argument selects which JSON-schema variant the underlying
 * Standard Schema exposes:
 *
 * - `"output"` (provider structured output): prefer `~standard.jsonSchema.output`,
 *   fall back to `.input`. The SDK validates the model's structured response
 *   and we return the parsed value on `LlmResult.output` / `AgentResult.output`.
 * - `"input"` (tool input schema): prefer `~standard.jsonSchema.input`, fall
 *   back to `.output`. The SDK shows the JSON schema to the model in the tool
 *   list and validates the model's tool-call args before calling `execute`.
 *
 * @internal
 */
function toAiSchema(
  schema: StandardSchemaV1,
  direction: "input" | "output",
  errorContext: string,
): unknown {
  const standard = (schema as unknown as Record<string, unknown>)[
    "~standard"
  ] as
    | {
        validate: (
          value: unknown,
        ) =>
          | { value?: unknown; issues?: unknown }
          | Promise<{ value?: unknown; issues?: unknown }>;
        jsonSchema?: {
          output?: (opts: { target: string }) => Record<string, unknown>;
          input?: (opts: { target: string }) => Record<string, unknown>;
        };
      }
    | undefined;

  if (!standard?.validate) {
    throw new Error(
      `${errorContext} must be a StandardSchemaV1 with ~standard.validate`,
    );
  }

  const primary =
    direction === "input"
      ? standard.jsonSchema?.input
      : standard.jsonSchema?.output;
  const fallback =
    direction === "input"
      ? standard.jsonSchema?.output
      : standard.jsonSchema?.input;
  const jsonSchemaObj =
    primary?.({ target: "draft-2020-12" }) ??
    fallback?.({ target: "draft-2020-12" });

  if (!jsonSchemaObj || typeof jsonSchemaObj !== "object") {
    throw new Error(
      `${errorContext} must expose ~standard.jsonSchema.input or .output for AI SDK use`,
    );
  }

  function validate(
    value: unknown,
  ): { success: true; value: unknown } | { success: false; error: Error } {
    let result:
      | { value?: unknown; issues?: unknown }
      | Promise<{
          value?: unknown;
          issues?: unknown;
        }>;
    try {
      result = standard!.validate(value);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (result instanceof Promise) {
      return {
        success: false,
        error: new Error(
          `${errorContext}: async schema validation is not supported`,
        ),
      };
    }
    const hasIssues =
      result.issues != null &&
      (Array.isArray(result.issues)
        ? result.issues.length > 0
        : typeof result.issues === "object" && result.issues !== null
          ? Object.keys(result.issues).length > 0
          : Boolean(result.issues));
    if (hasIssues) {
      return {
        success: false,
        error: new Error(formatSchemaIssues(result.issues)),
      };
    }
    return { success: true, value: result.value };
  }

  return jsonSchema(jsonSchemaObj as Parameters<typeof jsonSchema>[0], {
    validate,
  });
}

/**
 * Build an AI SDK input schema for tool definitions
 * (`tool({ inputSchema, execute })`). The SDK presents this schema to
 * the model in the tool list and validates the model's tool-call
 * arguments before invoking `execute`.
 *
 * @internal
 */
export function toAiInputSchema(schema: StandardSchemaV1): unknown {
  return toAiSchema(schema, "input", "Tool input schema");
}

/**
 * Build an AI SDK output spec from a Standard Schema for provider-level
 * structured output (OpenAI response_format, Ollama format, etc.) and
 * validation. Delegates to {@link toAiSchema} so the JSON-schema
 * extraction, validation wrapper, and error messages stay aligned with
 * the input-schema path used by tool definitions (no risk of drift
 * between the two paths).
 *
 * The AI SDK accepts Zod directly in Output.object({ schema: z.object(...) }).
 * This package uses Standard Schema (per .standards/type-safety-and-schemas.md),
 * so it cannot depend on Zod. The `toAiSchema` helper bridges any
 * Standard Schema (Zod, Valibot, ArkType, etc.) by using the SDK's
 * lower-level `jsonSchema(jsonSchemaObj, { validate })`.
 */
export function toAiOutputSpec(schema: StandardSchemaV1): unknown {
  const aiSchema = toAiSchema(
    schema,
    "output",
    "LLM output schema",
  ) as Parameters<typeof Output.object>[0]["schema"];
  return Output.object({ schema: aiSchema });
}
