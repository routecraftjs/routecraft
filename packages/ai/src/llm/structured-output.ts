import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output, jsonSchema } from "ai";

/**
 * Build an AI SDK output spec from a Standard Schema for provider-level
 * structured output (OpenAI response_format, Ollama format, etc.) and validation.
 *
 * The AI SDK accepts Zod directly in Output.object({ schema: z.object(...) }).
 * This package uses Standard Schema (per .standards/type-safety-and-schemas.md), so
 * it cannot depend on Zod. This helper bridges any Standard Schema (Zod, Valibot,
 * ArkType, etc.) by using the SDK’s lower-level jsonSchema(jsonSchemaObj, {
 * validate }): we get the JSON schema from ~standard.jsonSchema.output/.input
 * and use ~standard.validate as the validate callback. Callers can pass a Zod
 * schema (as Standard Schema), Valibot, or ArkType and get the same behavior.
 */
export function toAiOutputSpec(schema: StandardSchemaV1): unknown {
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
      "LLM outputSchema must be a StandardSchemaV1 with ~standard.validate",
    );
  }

  const jsonSchemaObj =
    standard.jsonSchema?.output?.({ target: "draft-2020-12" }) ??
    standard.jsonSchema?.input?.({ target: "draft-2020-12" });

  if (!jsonSchemaObj || typeof jsonSchemaObj !== "object") {
    throw new Error(
      "LLM outputSchema must expose ~standard.jsonSchema.output or .input for provider structured output",
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
          "Async output schema is not supported for LLM structured output",
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
        error: new Error(
          typeof result.issues === "string"
            ? result.issues
            : JSON.stringify(result.issues),
        ),
      };
    }
    return { success: true, value: result.value };
  }

  const aiSchema = jsonSchema(
    jsonSchemaObj as Parameters<typeof jsonSchema>[0],
    { validate },
  );
  return Output.object({ schema: aiSchema });
}
